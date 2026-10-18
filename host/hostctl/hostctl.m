// vmapp-hostctl: the native macOS helper behind vmapp's host capabilities (SPEC 8.2, GOVERNANCE H).
//
// The loader (Electron) spawns this process and speaks newline-delimited JSON over stdin/stdout:
//   request  {"id":N,"op":"...",...}
//   reply    {"id":N,"ok":true,"result":...}  or  {"id":N,"ok":false,"error":{"code":"...","message":"..."}}
//   event    {"event":"panic"}                (unsolicited, only after op "panic-hotkey" {enable:true})
// Nothing else is ever written to stdout (it is re-pointed at stderr after we take a private copy).
// The process exits on stdin EOF, or when its parent exits (kqueue NOTE_EXIT), so a crashed loader
// can never leave it behind. See README.md for the full protocol and the TCC model.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <dlfcn.h>
#include <pthread.h>
#include <sys/event.h>
#include <sys/time.h>
#include <unistd.h>

// ---------------------------------------------------------------------------------------------
// Output channel
// ---------------------------------------------------------------------------------------------

static int g_out = -1;                 // private copy of the original stdout
static pthread_mutex_t g_outLock = PTHREAD_MUTEX_INITIALIZER;

static void writeAll(int fd, const uint8_t *p, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            _exit(0);                  // the reader is gone: nothing left to serve
        }
        p += (size_t)w;
        n -= (size_t)w;
    }
}

static void emitObject(NSDictionary *obj) {
    NSData *data = nil;
    @try {
        if ([NSJSONSerialization isValidJSONObject:obj]) {
            data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
        }
    } @catch (NSException *e) {
        data = nil;
    }
    if (!data) {
        data = [@"{\"ok\":false,\"error\":{\"code\":\"internal\",\"message\":\"could not encode reply\"}}"
                dataUsingEncoding:NSUTF8StringEncoding];
    }
    NSMutableData *line = [NSMutableData dataWithData:data];
    [line appendBytes:"\n" length:1];
    pthread_mutex_lock(&g_outLock);
    writeAll(g_out, line.bytes, line.length);
    pthread_mutex_unlock(&g_outLock);
}

// ---------------------------------------------------------------------------------------------
// Errors and argument helpers
// ---------------------------------------------------------------------------------------------

static NSString *const kDomain = @"vmapp.hostctl";

// Sets *err and returns nil (so handlers can `return fail(...)`).
static id fail(NSError **err, NSString *code, NSString *msg) {
    if (err) *err = [NSError errorWithDomain:kDomain code:1 userInfo:@{@"code": code, NSLocalizedDescriptionKey: msg}];
    return nil;
}

static BOOL isBool(id v) { return [v isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)v) == CFBooleanGetTypeID(); }
static BOOL isNum(id v) {
    return [v isKindOfClass:[NSNumber class]] && !isBool(v) && isfinite([(NSNumber *)v doubleValue]);
}

// Optional/required typed getters. They return NO and set *err on a type mismatch or (when
// required) a missing key. *has reports whether the key was present.
static BOOL argNum(NSDictionary *r, NSString *k, BOOL required, double *out, BOOL *has, NSError **err) {
    id v = r[k];
    if (has) *has = (v != nil && v != [NSNull null]);
    if (v == nil || v == [NSNull null]) {
        if (required) { fail(err, @"bad-request", [NSString stringWithFormat:@"missing number \"%@\"", k]); return NO; }
        return YES;
    }
    if (!isNum(v)) { fail(err, @"bad-request", [NSString stringWithFormat:@"\"%@\" must be a finite number", k]); return NO; }
    double d = [v doubleValue];
    if (fabs(d) > 1e7) { fail(err, @"bad-request", [NSString stringWithFormat:@"\"%@\" is out of range", k]); return NO; }
    *out = d;
    return YES;
}

static BOOL argBool(NSDictionary *r, NSString *k, BOOL required, BOOL *out, BOOL *has, NSError **err) {
    id v = r[k];
    if (has) *has = (v != nil && v != [NSNull null]);
    if (v == nil || v == [NSNull null]) {
        if (required) { fail(err, @"bad-request", [NSString stringWithFormat:@"missing boolean \"%@\"", k]); return NO; }
        return YES;
    }
    if (!isBool(v)) { fail(err, @"bad-request", [NSString stringWithFormat:@"\"%@\" must be a boolean", k]); return NO; }
    *out = [v boolValue];
    return YES;
}

static BOOL argStr(NSDictionary *r, NSString *k, BOOL required, NSString **out, NSError **err) {
    id v = r[k];
    if (v == nil || v == [NSNull null]) {
        if (required) { fail(err, @"bad-request", [NSString stringWithFormat:@"missing string \"%@\"", k]); return NO; }
        *out = nil;
        return YES;
    }
    if (![v isKindOfClass:[NSString class]]) { fail(err, @"bad-request", [NSString stringWithFormat:@"\"%@\" must be a string", k]); return NO; }
    *out = v;
    return YES;
}

// ---------------------------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------------------------

static BOOL screenRecordingGranted(void) { return CGPreflightScreenCaptureAccess(); }

static BOOL accessibilityGranted(BOOL prompt) {
    NSDictionary *opts = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt)};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
}

static NSString *macosVersion(void) {
    NSOperatingSystemVersion v = [[NSProcessInfo processInfo] operatingSystemVersion];
    return [NSString stringWithFormat:@"%ld.%ld", (long)v.majorVersion, (long)v.minorVersion];
}

static id opStatus(NSDictionary *r, NSError **err) {
    return @{@"screenRecording": @(screenRecordingGranted()),
             @"accessibility": @(accessibilityGranted(NO)),
             @"macos": macosVersion()};
}

static id opRequestPermissions(NSDictionary *r, NSError **err) {
    BOOL sr = NO, ax = NO;
    if (!argBool(r, @"screenRecording", NO, &sr, NULL, err)) return nil;
    if (!argBool(r, @"accessibility", NO, &ax, NULL, err)) return nil;
    if (sr) CGRequestScreenCaptureAccess();
    if (ax) accessibilityGranted(YES);
    return opStatus(r, err);
}

// ---------------------------------------------------------------------------------------------
// Displays and windows
// ---------------------------------------------------------------------------------------------

static NSDictionary *rectDict(CGRect b) {
    return @{@"x": @(b.origin.x), @"y": @(b.origin.y), @"w": @(b.size.width), @"h": @(b.size.height)};
}

static double displayScale(CGDirectDisplayID d) {
    double scale = 1;
    CGDisplayModeRef m = CGDisplayCopyDisplayMode(d);
    if (m) {
        size_t pw = CGDisplayModeGetPixelWidth(m), w = CGDisplayModeGetWidth(m);
        if (pw > 0 && w > 0) scale = (double)pw / (double)w;
        CGDisplayModeRelease(m);
    }
    return scale;
}

// The user-facing name of a display ("Built-in Retina Display", "DELL U2723QE"), for the loader's picker. NSScreen is
// read on the main thread (it runs the NSApplication loop); falls back to "Display <id>".
static NSString *displayName(CGDirectDisplayID d) {
    __block NSString *name = nil;
    void (^find)(void) = ^{
        if (@available(macOS 10.15, *)) {
            for (NSScreen *s in [NSScreen screens]) {
                NSNumber *num = s.deviceDescription[@"NSScreenNumber"];
                if (num && (CGDirectDisplayID)num.unsignedIntValue == d) { name = [s.localizedName copy]; break; }
            }
        }
    };
    if ([NSThread isMainThread]) find(); else dispatch_sync(dispatch_get_main_queue(), find);
    return name.length ? name : [NSString stringWithFormat:@"Display %u", (unsigned)d];
}

static id opDisplays(NSDictionary *r, NSError **err) {
    CGDirectDisplayID ids[16];
    uint32_t n = 0;
    if (CGGetActiveDisplayList(16, ids, &n) != kCGErrorSuccess) return fail(err, @"failed", @"CGGetActiveDisplayList failed");
    CGDirectDisplayID mainD = CGMainDisplayID();
    NSMutableArray *out = [NSMutableArray array];
    for (uint32_t i = 0; i < n; i++) {
        [out addObject:@{@"display": @(ids[i]),
                         @"bounds": rectDict(CGDisplayBounds(ids[i])),
                         @"scale": @(displayScale(ids[i])),
                         @"main": [NSNumber numberWithBool:ids[i] == mainD],
                         @"name": displayName(ids[i]),
                         @"builtin": [NSNumber numberWithBool:CGDisplayIsBuiltin(ids[i]) != 0]}];
    }
    return out;
}

static id opWindows(NSDictionary *r, NSError **err) {
    BOOL all = NO;
    if (!argBool(r, @"all", NO, &all, NULL, err)) return nil;
    CGWindowListOption opt = all ? kCGWindowListOptionAll
                                 : (kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements);
    CFArrayRef list = CGWindowListCopyWindowInfo(opt, kCGNullWindowID);
    if (!list) return fail(err, @"failed", @"CGWindowListCopyWindowInfo returned nothing");
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *w in (__bridge NSArray *)list) {
        int layer = [w[(__bridge NSString *)kCGWindowLayer] intValue];
        if (!all && layer != 0) continue;
        CGRect b = CGRectZero;
        NSDictionary *bd = w[(__bridge NSString *)kCGWindowBounds];
        if (bd) CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bd, &b);
        NSString *app = w[(__bridge NSString *)kCGWindowOwnerName] ?: @"";
        NSString *title = w[(__bridge NSString *)kCGWindowName] ?: @"";   // empty without Screen Recording
        [out addObject:@{@"windowId": w[(__bridge NSString *)kCGWindowNumber] ?: @0,
                         @"app": app,
                         @"pid": w[(__bridge NSString *)kCGWindowOwnerPID] ?: @0,
                         @"title": title,
                         @"bounds": rectDict(b),
                         @"onScreen": @([w[(__bridge NSString *)kCGWindowIsOnscreen] boolValue]),
                         @"layer": @(layer)}];
    }
    CFRelease(list);
    return out;
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

// Draws `img` into a w x h sRGB bitmap (scaling if needed) and encodes it as PNG.
static NSData *encodePNG(CGImageRef img, size_t w, size_t h) {
    if (!img || w == 0 || h == 0) return nil;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, cs, (CGBitmapInfo)kCGImageAlphaNoneSkipLast);
    CGColorSpaceRelease(cs);
    if (!ctx) return nil;
    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    CGContextDrawImage(ctx, CGRectMake(0, 0, (CGFloat)w, (CGFloat)h), img);
    CGImageRef out = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (!out) return nil;
    NSMutableData *data = [NSMutableData data];
    CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, CFSTR("public.png"), 1, NULL);
    NSData *result = nil;
    if (dest) {
        CGImageDestinationAddImage(dest, out, NULL);
        if (CGImageDestinationFinalize(dest)) result = data;
        CFRelease(dest);
    }
    CGImageRelease(out);
    return result;
}

typedef CGImageRef (*CGWindowListCreateImageFn)(CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption);
typedef CGImageRef (*CGWindowListCreateImageFromArrayFn)(CGRect, CFArrayRef, CGWindowImageOption);

// Legacy path (macOS 13, or {legacy:true}). The symbols are obsoleted in the macOS 15 SDK, so they are
// looked up at run time; on systems that dropped them this returns NULL.
//
// `excludePids`: windows owned by those processes (the loader's own badge, overlay, picker) must not be in the
// picture. CGWindowListCreateImage has no "all except" mode, so for a display or region capture with exclusions the
// on-screen window list is built here without them and CGWindowListCreateImageFromArray composites exactly that list
// (BEST EFFORT: the array path does not draw the desktop picture's menu-bar extras the way the plain path does, and
// the ScreenCaptureKit path above is the one that is exact). A window target is a single window and needs no filter.
static CGImageRef legacyCapture(CGRect rect, CGWindowID windowId, BOOL isWindow, BOOL native, NSSet<NSNumber *> *excludePids) {
    static CGWindowListCreateImageFn fn;
    static CGWindowListCreateImageFromArrayFn fnArr;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        fn = (CGWindowListCreateImageFn)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage");
        fnArr = (CGWindowListCreateImageFromArrayFn)dlsym(RTLD_DEFAULT, "CGWindowListCreateImageFromArray");
    });
    CGWindowImageOption io = kCGWindowImageBoundsIgnoreFraming | (native ? kCGWindowImageBestResolution : kCGWindowImageNominalResolution);
    if (isWindow) return fn ? fn(CGRectNull, kCGWindowListOptionIncludingWindow, windowId, io) : NULL;
    if (excludePids.count && fnArr) {
        CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
        if (list) {
            NSMutableData *ids = [NSMutableData data];
            NSUInteger n = 0;
            for (NSDictionary *w in (__bridge NSArray *)list) {
                if ([excludePids containsObject:@([w[(__bridge NSString *)kCGWindowOwnerPID] intValue])]) continue;
                const void *v = (const void *)(uintptr_t)[w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
                [ids appendBytes:&v length:sizeof v];
                n++;
            }
            CFRelease(list);
            CFArrayRef arr = CFArrayCreate(NULL, (const void **)ids.bytes, (CFIndex)n, NULL);   // raw window ids, no callbacks
            CGImageRef img = arr ? fnArr(rect, arr, io) : NULL;
            if (arr) CFRelease(arr);
            if (img) return img;
        }
    }
    return fn ? fn(rect, kCGWindowListOptionOnScreenOnly, kCGNullWindowID, io | 0) : NULL;
}

// Bounds (global points) and owner pid of a window. NO when there is no such window.
static BOOL findWindowBounds(CGWindowID wid, CGRect *out, int *ownerPid) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, wid);
    if (!list) return NO;
    BOOL found = NO;
    for (NSDictionary *w in (__bridge NSArray *)list) {
        if ([w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] != wid) continue;
        NSDictionary *bd = w[(__bridge NSString *)kCGWindowBounds];
        if (bd && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bd, out)) {
            found = YES;
            if (ownerPid) *ownerPid = [w[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        }
    }
    CFRelease(list);
    return found;
}

static BOOL displayContaining(CGRect r, CGDirectDisplayID *out) {
    CGDirectDisplayID ids[16];
    uint32_t n = 0;
    if (CGGetActiveDisplayList(16, ids, &n) != kCGErrorSuccess) return NO;
    CGFloat best = 0;
    BOOL found = NO;
    for (uint32_t i = 0; i < n; i++) {
        CGRect inter = CGRectIntersection(CGDisplayBounds(ids[i]), r);
        CGFloat area = CGRectIsNull(inter) ? 0 : inter.size.width * inter.size.height;
        if (area > best) { best = area; *out = ids[i]; found = YES; }
    }
    return found;
}

static BOOL displayExists(CGDirectDisplayID d) {
    CGDirectDisplayID ids[16];
    uint32_t n = 0;
    if (CGGetActiveDisplayList(16, ids, &n) != kCGErrorSuccess) return NO;
    for (uint32_t i = 0; i < n; i++) if (ids[i] == d) return YES;
    return NO;
}

// ScreenCaptureKit capture (macOS 14+). rect is in global points; for window targets it is ignored
// apart from sizing. Returns a retained CGImage (caller releases) or NULL with *err set.
// `excludePids`: for a display or region capture every window owned by one of those processes is left out of the
// picture (SCContentFilter excludingWindows), whatever its level or sharing type. This is how the loader's own badge,
// virtual-input overlay and pickers stay out of screenshots even where NSWindowSharingNone is no longer honoured.
static CGImageRef sckCapture(NSString *target, CGDirectDisplayID display, CGWindowID wid, CGRect rect,
                             size_t pxW, size_t pxH, NSSet<NSNumber *> *excludePids, NSError **err) API_AVAILABLE(macos(14.0)) {
    __block SCShareableContent *content = nil;
    __block NSError *cerr = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO
                                                 completionHandler:^(SCShareableContent *c, NSError *e) {
        content = c; cerr = e; dispatch_semaphore_signal(sem);
    }];
    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC)) != 0) {
        fail(err, @"timeout", @"ScreenCaptureKit did not answer in time");
        return NULL;
    }
    if (!content) {
        BOOL denied = cerr && cerr.code == -3801;
        fail(err, denied ? @"permission" : @"failed",
             [NSString stringWithFormat:@"ScreenCaptureKit: %@", cerr.localizedDescription ?: @"no content"]);
        return NULL;
    }
    SCContentFilter *filter = nil;
    SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
    cfg.width = pxW;
    cfg.height = pxH;
    cfg.showsCursor = NO;
    cfg.scalesToFit = YES;
    if ([target isEqualToString:@"window"]) {
        SCWindow *win = nil;
        for (SCWindow *w in content.windows) if (w.windowID == wid) { win = w; break; }
        if (!win) { fail(err, @"not-found", @"window not found"); return NULL; }
        filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:win];
    } else {
        SCDisplay *disp = nil;
        for (SCDisplay *d in content.displays) if (d.displayID == display) { disp = d; break; }
        if (!disp) { fail(err, @"not-found", @"display not found"); return NULL; }
        NSMutableArray<SCWindow *> *excluded = [NSMutableArray array];
        if (excludePids.count) {
            for (SCWindow *w in content.windows) {
                SCRunningApplication *a = w.owningApplication;
                if (a && [excludePids containsObject:@(a.processID)]) [excluded addObject:w];
            }
        }
        filter = [[SCContentFilter alloc] initWithDisplay:disp excludingWindows:excluded];
        if ([target isEqualToString:@"region"]) {
            CGRect db = CGDisplayBounds(display);
            cfg.sourceRect = CGRectMake(rect.origin.x - db.origin.x, rect.origin.y - db.origin.y,
                                        rect.size.width, rect.size.height);
        }
    }
    __block CGImageRef image = NULL;
    __block NSError *ierr = nil;
    dispatch_semaphore_t sem2 = dispatch_semaphore_create(0);
    [SCScreenshotManager captureImageWithFilter:filter configuration:cfg completionHandler:^(CGImageRef im, NSError *e) {
        if (im) image = CGImageRetain(im);
        ierr = e;
        dispatch_semaphore_signal(sem2);
    }];
    if (dispatch_semaphore_wait(sem2, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC)) != 0) {
        fail(err, @"timeout", @"screenshot did not complete in time");
        return NULL;
    }
    if (!image) {
        BOOL denied = ierr && ierr.code == -3801;
        fail(err, denied ? @"permission" : @"failed",
             [NSString stringWithFormat:@"screenshot failed: %@", ierr.localizedDescription ?: @"no image"]);
        return NULL;
    }
    return image;
}

static id opCapture(NSDictionary *r, NSError **err) {
    NSString *target = nil;
    if (!argStr(r, @"target", YES, &target, err)) return nil;
    if (!([target isEqualToString:@"display"] || [target isEqualToString:@"window"] || [target isEqualToString:@"region"]))
        return fail(err, @"bad-request", @"target must be \"display\", \"window\" or \"region\"");

    double d = 0, maxW = 0, wid = 0;
    BOOL hasDisplay = NO, hasMax = NO, hasWin = NO, legacy = NO, native = NO;
    if (!argNum(r, @"display", NO, &d, &hasDisplay, err)) return nil;
    if (!argNum(r, @"maxWidth", NO, &maxW, &hasMax, err)) return nil;
    if (!argNum(r, @"windowId", [target isEqualToString:@"window"], &wid, &hasWin, err)) return nil;
    if (!argBool(r, @"legacy", NO, &legacy, NULL, err)) return nil;     // diagnostic: force the CGWindowList path
    if (!argBool(r, @"native", NO, &native, NULL, err)) return nil;     // pixel (not point) resolution
    if (hasMax && (maxW < 1 || maxW > 16384)) return fail(err, @"bad-request", @"maxWidth must be between 1 and 16384");
    if (hasDisplay && (d < 0 || d > 4294967295.0)) return fail(err, @"bad-request", @"invalid display id");

    // excludePids: processes whose windows must not appear in the picture (the loader's own: badge, overlay, pickers).
    NSMutableSet<NSNumber *> *excludePids = [NSMutableSet set];
    id ex = r[@"excludePids"];
    if (ex != nil && ex != [NSNull null]) {
        if (![ex isKindOfClass:[NSArray class]] || [(NSArray *)ex count] > 64)
            return fail(err, @"bad-request", @"excludePids must be an array of at most 64 process ids");
        for (id p in (NSArray *)ex) {
            if (!isNum(p) || [p doubleValue] < 1 || [p doubleValue] > 2147483647.0 || [p doubleValue] != floor([p doubleValue]))
                return fail(err, @"bad-request", @"excludePids must contain process ids (integers from 1 to 2147483647)");
            [excludePids addObject:@([p intValue])];
        }
    }

    // Everything below needs Screen Recording.
    if (!screenRecordingGranted())
        return fail(err, @"permission", @"Screen Recording is not granted to this process (System Settings > Privacy & Security)");

    CGDirectDisplayID display = hasDisplay ? (CGDirectDisplayID)d : CGMainDisplayID();
    if (hasDisplay && !displayExists(display)) return fail(err, @"not-found", @"display not found");
    CGRect rect = CGRectZero;     // global points
    CGWindowID windowId = 0;

    if ([target isEqualToString:@"display"]) {
        rect = CGDisplayBounds(display);
    } else if ([target isEqualToString:@"window"]) {
        if (wid < 0 || wid > 4294967295.0) return fail(err, @"bad-request", @"invalid windowId");
        windowId = (CGWindowID)wid;
        int ownerPid = 0;
        if (!findWindowBounds(windowId, &rect, &ownerPid)) return fail(err, @"not-found", @"window not found");
        // a window of an excluded process (the loader's own) cannot be captured at all, however its id was learned
        if ([excludePids containsObject:@(ownerPid)]) return fail(err, @"not-found", @"window not found");
        if (!hasDisplay && !displayContaining(rect, &display)) display = CGMainDisplayID();
    } else {
        id reg = r[@"region"];
        if (![reg isKindOfClass:[NSDictionary class]]) return fail(err, @"bad-request", @"region {x,y,w,h} is required");
        double x = 0, y = 0, w = 0, h = 0;
        if (!argNum(reg, @"x", YES, &x, NULL, err) || !argNum(reg, @"y", YES, &y, NULL, err) ||
            !argNum(reg, @"w", YES, &w, NULL, err) || !argNum(reg, @"h", YES, &h, NULL, err)) return nil;
        if (w < 1 || h < 1 || w > 32768 || h > 32768) return fail(err, @"bad-request", @"region size must be between 1 and 32768");
        if (hasDisplay) {                       // display-relative coordinates
            CGRect db = CGDisplayBounds(display);
            x += db.origin.x; y += db.origin.y;
        } else {                                // global coordinates (same space as the mouse and windows)
            if (!displayContaining(CGRectMake(x, y, w, h), &display)) return fail(err, @"bad-request", @"region is outside every display");
        }
        rect = CGRectIntersection(CGRectMake(x, y, w, h), CGDisplayBounds(display));
        if (CGRectIsNull(rect) || rect.size.width < 1 || rect.size.height < 1) return fail(err, @"bad-request", @"region is outside the display");
    }

    double scale = native ? displayScale(display) : 1.0;
    double baseW = rect.size.width * scale, baseH = rect.size.height * scale;
    if (baseW < 1 || baseH < 1) return fail(err, @"not-found", @"nothing to capture (empty bounds)");
    double k = (hasMax && baseW > maxW) ? maxW / baseW : 1.0;
    size_t outW = (size_t)fmax(1, round(baseW * k)), outH = (size_t)fmax(1, round(baseH * k));

    CGImageRef img = NULL;
    NSError *cerr = nil;
    BOOL useSCK = NO;
    if (@available(macOS 14.0, *)) useSCK = !legacy;
    if (useSCK) {
        if (@available(macOS 14.0, *)) {
            img = sckCapture(target, display, windowId, rect, outW, outH, excludePids, &cerr);
        }
    } else {
        img = legacyCapture(rect, windowId, [target isEqualToString:@"window"], native, excludePids);
        if (!img) fail(&cerr, @"unavailable", @"legacy capture returned no image");
    }
    if (!img) { if (err) *err = cerr; return nil; }
    NSData *png = encodePNG(img, outW, outH);
    CGImageRelease(img);
    if (!png) return fail(err, @"failed", @"could not encode PNG");
    // `display` and `bounds` say what was really captured: the display used, and the area in global points (a region
    // after clipping to its display; a window's own bounds). The loader turns them into the app's `target`.
    return @{@"png": [png base64EncodedStringWithOptions:0], @"width": @(outW), @"height": @(outH),
             @"display": @(display), @"bounds": rectDict(rect)};
}

// ---------------------------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------------------------

static int g_heldButton = -1;     // -1 none, else CGMouseButton (so a move while held becomes a drag)

static BOOL postOrKeep(CGEventRef ev, BOOL dry, NSMutableArray *keep) {
    if (!ev) return NO;
    if (!dry) CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
    (void)keep;
    return YES;
}

static id opMouse(NSDictionary *r, NSError **err) {
    NSString *action = nil, *button = nil;
    if (!argStr(r, @"action", YES, &action, err)) return nil;
    if (!argStr(r, @"button", NO, &button, err)) return nil;
    double x = 0, y = 0, dx = 0, dy = 0, clicks = 1;
    BOOL hasX = NO, hasY = NO, dry = NO;
    BOOL isScroll = [action isEqualToString:@"scroll"];
    BOOL known = isScroll || [@[@"move", @"down", @"up", @"click"] containsObject:action];
    if (!known) return fail(err, @"bad-request", @"action must be move, down, up, click or scroll");
    if (!argNum(r, @"x", !isScroll, &x, &hasX, err) || !argNum(r, @"y", !isScroll, &y, &hasY, err)) return nil;
    if (!argNum(r, @"dx", NO, &dx, NULL, err) || !argNum(r, @"dy", NO, &dy, NULL, err)) return nil;
    if (!argNum(r, @"clicks", NO, &clicks, NULL, err)) return nil;
    if (!argBool(r, @"dryRun", NO, &dry, NULL, err)) return nil;
    if (hasX != hasY) return fail(err, @"bad-request", @"x and y must be given together");
    if (clicks < 1 || clicks > 3) return fail(err, @"bad-request", @"clicks must be 1, 2 or 3");

    CGMouseButton btn = kCGMouseButtonLeft;
    if (button) {
        if ([button isEqualToString:@"left"]) btn = kCGMouseButtonLeft;
        else if ([button isEqualToString:@"right"]) btn = kCGMouseButtonRight;
        else if ([button isEqualToString:@"middle"]) btn = kCGMouseButtonCenter;
        else return fail(err, @"bad-request", @"button must be left, right or middle");
    }
    if (isScroll && (fabs(dx) > 100000 || fabs(dy) > 100000)) return fail(err, @"bad-request", @"scroll delta out of range");

    if (!dry && !AXIsProcessTrusted())
        return fail(err, @"permission", @"Accessibility is not granted to this process (System Settings > Privacy & Security)");

    CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGPoint pt = CGPointMake(x, y);
    if (!hasX) {                                   // scroll without a position: wherever the cursor is
        CGEventRef cur = CGEventCreate(NULL);
        if (cur) { pt = CGEventGetLocation(cur); CFRelease(cur); }
    }
    CGEventType downT = btn == kCGMouseButtonLeft ? kCGEventLeftMouseDown : btn == kCGMouseButtonRight ? kCGEventRightMouseDown : kCGEventOtherMouseDown;
    CGEventType upT = btn == kCGMouseButtonLeft ? kCGEventLeftMouseUp : btn == kCGMouseButtonRight ? kCGEventRightMouseUp : kCGEventOtherMouseUp;
    CGEventType dragT = btn == kCGMouseButtonLeft ? kCGEventLeftMouseDragged : btn == kCGMouseButtonRight ? kCGEventRightMouseDragged : kCGEventOtherMouseDragged;
    int built = 0;
    BOOL ok = YES;

    if ([action isEqualToString:@"move"]) {
        CGEventType t = g_heldButton >= 0 ? (g_heldButton == 0 ? kCGEventLeftMouseDragged : g_heldButton == 1 ? kCGEventRightMouseDragged : kCGEventOtherMouseDragged) : kCGEventMouseMoved;
        CGMouseButton b = g_heldButton >= 0 ? (CGMouseButton)g_heldButton : kCGMouseButtonLeft;
        ok = postOrKeep(CGEventCreateMouseEvent(src, t, pt, b), dry, nil); built++;
    } else if ([action isEqualToString:@"down"] || [action isEqualToString:@"up"]) {
        BOOL isDown = [action isEqualToString:@"down"];
        ok = postOrKeep(CGEventCreateMouseEvent(src, isDown ? downT : upT, pt, btn), dry, nil); built++;
        if (ok && !dry) g_heldButton = isDown ? (int)btn : -1;
    } else if ([action isEqualToString:@"click"]) {
        ok = postOrKeep(CGEventCreateMouseEvent(src, kCGEventMouseMoved, pt, btn), dry, nil); built++;
        if (!dry) usleep(15000);
        for (int i = 1; ok && i <= (int)clicks; i++) {
            CGEventRef dn = CGEventCreateMouseEvent(src, downT, pt, btn);
            CGEventRef up = CGEventCreateMouseEvent(src, upT, pt, btn);
            if (!dn || !up) { if (dn) CFRelease(dn); if (up) CFRelease(up); ok = NO; break; }
            CGEventSetIntegerValueField(dn, kCGMouseEventClickState, i);
            CGEventSetIntegerValueField(up, kCGMouseEventClickState, i);
            ok = postOrKeep(dn, dry, nil); built++;
            if (!dry) usleep(15000);
            ok = postOrKeep(up, dry, nil) && ok; built++;
            if (!dry) usleep(15000);
        }
        if (!dry) g_heldButton = -1;
    } else {   // scroll: dx/dy follow the DOM wheel convention (positive dy = scroll down), CG's is the opposite.
        if (hasX && !dry) { ok = postOrKeep(CGEventCreateMouseEvent(src, kCGEventMouseMoved, pt, btn), dry, nil); usleep(15000); }
        built++;
        int32_t w1 = (int32_t)lround(-dy), w2 = (int32_t)lround(-dx);
        CGEventRef sc = CGEventCreateScrollWheelEvent(src, kCGScrollEventUnitPixel, 2, w1, w2);
        if (sc) CGEventSetLocation(sc, pt);
        ok = ok && postOrKeep(sc, dry, nil);
    }
    (void)dragT;
    if (src) CFRelease(src);
    if (!ok) return fail(err, @"failed", @"could not create the input event");
    return @{@"posted": [NSNumber numberWithBool:!dry], @"events": @(built)};
}

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

static NSDictionary<NSString *, NSNumber *> *keycodes(void) {
    static NSDictionary *m;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        m = @{@"a": @0, @"s": @1, @"d": @2, @"f": @3, @"h": @4, @"g": @5, @"z": @6, @"x": @7, @"c": @8, @"v": @9,
              @"b": @11, @"q": @12, @"w": @13, @"e": @14, @"r": @15, @"y": @16, @"t": @17,
              @"1": @18, @"2": @19, @"3": @20, @"4": @21, @"6": @22, @"5": @23, @"=": @24, @"9": @25, @"7": @26,
              @"-": @27, @"8": @28, @"0": @29, @"]": @30, @"o": @31, @"u": @32, @"[": @33, @"i": @34, @"p": @35,
              @"return": @36, @"enter": @36, @"l": @37, @"j": @38, @"'": @39, @"k": @40, @";": @41, @"\\": @42,
              @",": @43, @"/": @44, @"n": @45, @"m": @46, @".": @47, @"tab": @48, @"space": @49, @"`": @50,
              @"delete": @51, @"backspace": @51, @"escape": @53, @"esc": @53,
              @"forwarddelete": @117, @"home": @115, @"end": @119, @"pageup": @116, @"pagedown": @121,
              @"left": @123, @"right": @124, @"down": @125, @"up": @126,
              @"f1": @122, @"f2": @120, @"f3": @99, @"f4": @118, @"f5": @96, @"f6": @97, @"f7": @98, @"f8": @100,
              @"f9": @101, @"f10": @109, @"f11": @103, @"f12": @111};
    });
    return m;
}

static BOOL postKey(CGEventSourceRef src, CGKeyCode code, BOOL down, CGEventFlags flags, const UniChar *uni, UniCharCount n,
                    BOOL dry) {
    CGEventRef ev = CGEventCreateKeyboardEvent(src, code, down);
    if (!ev) return NO;
    if (uni && n > 0) CGEventKeyboardSetUnicodeString(ev, n, uni);
    CGEventSetFlags(ev, flags);
    if (!dry) CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
    return YES;
}

static id opKeys(NSDictionary *r, NSError **err) {
    NSString *text = nil, *key = nil;
    BOOL dry = NO;
    if (!argStr(r, @"text", NO, &text, err) || !argStr(r, @"key", NO, &key, err)) return nil;
    if (!argBool(r, @"dryRun", NO, &dry, NULL, err)) return nil;
    if ((text == nil) == (key == nil)) return fail(err, @"bad-request", @"give exactly one of \"text\" or \"key\"");

    CGEventFlags flags = 0;
    id mods = r[@"modifiers"];
    if (mods != nil && mods != [NSNull null]) {
        if (![mods isKindOfClass:[NSArray class]] || [(NSArray *)mods count] > 8) return fail(err, @"bad-request", @"modifiers must be an array of cmd, shift, alt, ctrl");
        if (text) return fail(err, @"bad-request", @"modifiers only apply to \"key\"");
        for (id m in (NSArray *)mods) {
            if (![m isKindOfClass:[NSString class]]) return fail(err, @"bad-request", @"modifiers must be strings");
            NSString *s = [(NSString *)m lowercaseString];
            if ([s isEqualToString:@"cmd"] || [s isEqualToString:@"command"]) flags |= kCGEventFlagMaskCommand;
            else if ([s isEqualToString:@"shift"]) flags |= kCGEventFlagMaskShift;
            else if ([s isEqualToString:@"alt"] || [s isEqualToString:@"option"]) flags |= kCGEventFlagMaskAlternate;
            else if ([s isEqualToString:@"ctrl"] || [s isEqualToString:@"control"]) flags |= kCGEventFlagMaskControl;
            else return fail(err, @"bad-request", [NSString stringWithFormat:@"unknown modifier \"%@\"", m]);
        }
    }
    if (text && text.length > 10000) return fail(err, @"bad-request", @"text is limited to 10000 characters");

    NSNumber *code = nil;
    if (key) {
        code = keycodes()[[key lowercaseString]];
        if (!code) return fail(err, @"bad-request", [NSString stringWithFormat:@"unknown key \"%@\"", key]);
    }
    if (!dry && !AXIsProcessTrusted())
        return fail(err, @"permission", @"Accessibility is not granted to this process (System Settings > Privacy & Security)");

    CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    __block int built = 0;
    __block BOOL ok = YES;
    if (key) {
        ok = postKey(src, (CGKeyCode)code.intValue, YES, flags, NULL, 0, dry); built++;
        if (!dry) usleep(8000);
        ok = postKey(src, (CGKeyCode)code.intValue, NO, flags, NULL, 0, dry) && ok; built++;
    } else {
        NSMutableString *buf = [NSMutableString string];
        void (^flush)(void) = ^{
            if (buf.length == 0) return;
            UniChar u[64];
            NSUInteger n = MIN(buf.length, (NSUInteger)64);
            [buf getCharacters:u range:NSMakeRange(0, n)];
            ok = postKey(src, 0, YES, 0, u, n, dry) && ok; built++;
            if (!dry) usleep(4000);
            ok = postKey(src, 0, NO, 0, u, n, dry) && ok; built++;
            if (!dry) usleep(4000);
            [buf setString:@""];
        };
        void (^special)(CGKeyCode) = ^(CGKeyCode kc) {
            flush();
            ok = postKey(src, kc, YES, 0, NULL, 0, dry) && ok; built++;
            if (!dry) usleep(4000);
            ok = postKey(src, kc, NO, 0, NULL, 0, dry) && ok; built++;
        };
        [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences
                              usingBlock:^(NSString *sub, NSRange rg, NSRange er, BOOL *stop) {
            if ([sub isEqualToString:@"\n"] || [sub isEqualToString:@"\r"] || [sub isEqualToString:@"\r\n"]) { special(36); return; }
            if ([sub isEqualToString:@"\t"]) { special(48); return; }
            if (buf.length + sub.length > 16) flush();    // keep each event small; never split a character
            [buf appendString:sub];
        }];
        flush();
    }
    if (src) CFRelease(src);
    if (!ok) return fail(err, @"failed", @"could not create the keyboard event");
    return @{@"posted": [NSNumber numberWithBool:!dry], @"events": @(built)};
}

// ---------------------------------------------------------------------------------------------
// Panic hotkey (Control-Option-Command-period) via Carbon RegisterEventHotKey. It needs no
// Accessibility permission. Must be registered from the main thread, which runs the NSApplication loop.
// ---------------------------------------------------------------------------------------------

static EventHotKeyRef g_hotKey = NULL;
static EventHandlerRef g_hotHandler = NULL;

static OSStatus hotKeyHandler(EventHandlerCallRef next, EventRef ev, void *ud) {
    emitObject(@{@"event": @"panic"});
    return noErr;
}

static OSStatus setPanicHotKey(BOOL enable) {
    if (enable) {
        if (g_hotKey) return noErr;
        if (!g_hotHandler) {
            EventTypeSpec spec = {kEventClassKeyboard, kEventHotKeyPressed};
            OSStatus s = InstallEventHandler(GetApplicationEventTarget(), NewEventHandlerUPP(hotKeyHandler), 1, &spec, NULL, &g_hotHandler);
            if (s != noErr) return s;
        }
        EventHotKeyID hid = {'vmph', 1};
        return RegisterEventHotKey(kVK_ANSI_Period, controlKey | optionKey | cmdKey, hid, GetApplicationEventTarget(), 0, &g_hotKey);
    }
    if (g_hotKey) { UnregisterEventHotKey(g_hotKey); g_hotKey = NULL; }
    return noErr;
}

static id opPanicHotkey(NSDictionary *r, NSError **err) {
    BOOL enable = NO;
    if (!argBool(r, @"enable", YES, &enable, NULL, err)) return nil;
    __block OSStatus st = noErr;
    if ([NSThread isMainThread]) st = setPanicHotKey(enable);
    else dispatch_sync(dispatch_get_main_queue(), ^{ st = setPanicHotKey(enable); });
    if (st != noErr) return fail(err, @"failed", [NSString stringWithFormat:@"could not register the panic hotkey (OSStatus %d)", (int)st]);
    return @{@"enabled": @(enable)};
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

static id opPing(NSDictionary *r, NSError **err) { return @{@"pong": @YES}; }

static void handleLine(NSData *line) {
    @autoreleasepool {
        id reqId = [NSNull null];
        NSError *jerr = nil;
        id obj = nil;
        @try { obj = [NSJSONSerialization JSONObjectWithData:line options:0 error:&jerr]; } @catch (NSException *e) { obj = nil; }
        if (![obj isKindOfClass:[NSDictionary class]]) {
            emitObject(@{@"id": reqId, @"ok": @NO, @"error": @{@"code": @"bad-request", @"message": @"request must be a JSON object on one line"}});
            return;
        }
        NSDictionary *req = obj;
        id rawId = req[@"id"];
        if ([rawId isKindOfClass:[NSNumber class]] || [rawId isKindOfClass:[NSString class]]) reqId = rawId;
        id opv = req[@"op"];
        if (![opv isKindOfClass:[NSString class]]) {
            emitObject(@{@"id": reqId, @"ok": @NO, @"error": @{@"code": @"bad-request", @"message": @"missing string \"op\""}});
            return;
        }
        static NSDictionary *ops;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            ops = @{@"ping": [NSValue valueWithPointer:(void *)opPing],
                    @"status": [NSValue valueWithPointer:(void *)opStatus],
                    @"request-permissions": [NSValue valueWithPointer:(void *)opRequestPermissions],
                    @"windows": [NSValue valueWithPointer:(void *)opWindows],
                    @"displays": [NSValue valueWithPointer:(void *)opDisplays],
                    @"capture": [NSValue valueWithPointer:(void *)opCapture],
                    @"mouse": [NSValue valueWithPointer:(void *)opMouse],
                    @"keys": [NSValue valueWithPointer:(void *)opKeys],
                    @"panic-hotkey": [NSValue valueWithPointer:(void *)opPanicHotkey]};
        });
        NSValue *fnv = ops[opv];
        if (!fnv) {
            emitObject(@{@"id": reqId, @"ok": @NO, @"error": @{@"code": @"unknown-op", @"message": [NSString stringWithFormat:@"unknown op \"%@\"", opv]}});
            return;
        }
        id (*fn)(NSDictionary *, NSError **) = (id (*)(NSDictionary *, NSError **))[fnv pointerValue];
        NSError *err = nil;
        id result = nil;
        @try { result = fn(req, &err); }
        @catch (NSException *e) {
            result = nil;
            err = [NSError errorWithDomain:kDomain code:2 userInfo:@{@"code": @"internal", NSLocalizedDescriptionKey: e.reason ?: @"exception"}];
        }
        if (result) {
            emitObject(@{@"id": reqId, @"ok": @YES, @"result": result});
        } else {
            NSString *code = err.userInfo[@"code"] ?: @"failed";
            emitObject(@{@"id": reqId, @"ok": @NO, @"error": @{@"code": code, @"message": err.localizedDescription ?: @"failed"}});
        }
    }
}

// Reads stdin lines forever; exits the process on EOF.
static void *readerThread(void *arg) {
    enum { kMaxLine = 8 * 1024 * 1024 };
    NSMutableData *buf = [NSMutableData data];
    BOOL discarding = NO;
    uint8_t chunk[65536];
    for (;;) {
        ssize_t n = read(0, chunk, sizeof chunk);
        if (n < 0) { if (errno == EINTR) continue; _exit(0); }
        if (n == 0) _exit(0);                              // EOF: the loader closed us
        size_t off = 0;
        while (off < (size_t)n) {
            const uint8_t *nl = memchr(chunk + off, '\n', (size_t)n - off);
            size_t take = nl ? (size_t)(nl - (chunk + off)) : (size_t)n - off;
            if (!discarding) {
                if (buf.length + take > kMaxLine) {
                    discarding = YES;
                    [buf setLength:0];
                    emitObject(@{@"id": [NSNull null], @"ok": @NO, @"error": @{@"code": @"bad-request", @"message": @"request line too long"}});
                } else {
                    [buf appendBytes:chunk + off length:take];
                }
            }
            off += take;
            if (nl) {
                off++;
                if (discarding) discarding = NO;
                else if (buf.length > 0) { handleLine(buf); }
                [buf setLength:0];
            }
        }
    }
    return NULL;
}

// Follows the parent like vmapp-vm: exits when it dies (kqueue NOTE_EXIT), so a crashed loader never leaves us behind.
static void *parentWatcher(void *arg) {
    pid_t ppid = (pid_t)(intptr_t)arg;
    int kq = kqueue();
    if (kq < 0) {
        for (;;) { sleep(1); if (getppid() != ppid) _exit(0); }   // fallback: poll
    }
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)ppid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    struct kevent out;
    int n = kevent(kq, &ev, 1, &out, 1, NULL);
    (void)n;   // fires on NOTE_EXIT, or fails with ESRCH when the parent is already gone: either way, leave
    _exit(0);
    return NULL;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        // Take a private copy of stdout for protocol replies; anything else that prints goes to stderr.
        g_out = dup(1);
        if (g_out < 0) return 1;
        dup2(2, 1);

        pid_t ppid = getppid();
        if (ppid <= 1) return 0;                     // already orphaned
        pthread_t t;
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
        pthread_create(&t, &attr, parentWatcher, (void *)(intptr_t)ppid);

        // AppKit gives us a connection to the window server and the event loop Carbon hot keys need.
        // Accessory policy: no Dock icon, no menu bar, no windows.
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];

        pthread_create(&t, &attr, readerThread, NULL);
        pthread_attr_destroy(&attr);
        [app run];
    }
    return 0;
}
