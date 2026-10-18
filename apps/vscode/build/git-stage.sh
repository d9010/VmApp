#!/bin/sh
# Runs INSIDE a container of the node22 runtime's base image (apps/vscode/build.sh starts it): takes Debian's git package, the one the
# runtime's Debian release (bookworm) ships, for the terminal and VS Code's Git extension. The runtime has no git, and its root file
# system is read-only: git is shipped in core/git and found through PATH and GIT_EXEC_PATH (core/main.js).
#
#   /out          receives git/ (bin/git, libexec/git-core/, share/git-core/templates/, share/doc/git/copyright) and git-stage.txt
#   APT_SNAPSHOT  the snapshot.debian.org date the package comes from
#   APT_GIT       the exact version of the package
#
# The image is the runtime's own base, so git links against exactly the libraries the VM has. The HTTP transports (git-remote-http/
# https/ftp, git-http-*, git-imap-send) need libcurl and libexpat, which the runtime does not have: Debian's packages of them (the same
# snapshot) are installed in the container, the shared libraries that are new compared with the runtime are copied to git/lib, and the
# programs that need them get the RUNPATH $ORIGIN/../../lib (the copied libraries $ORIGIN), so nothing global (LD_LIBRARY_PATH) changes
# in the VM. TLS verification uses the runtime's CA bundle (/etc/ssl/certs/ca-certificates.crt), the proxy the platform's environment
# (https_proxy). Left out: the Perl programs (git send-email, git svn, ...), which need Perl modules the runtime does not have.
set -eu
: "${APT_SNAPSHOT:?APT_SNAPSHOT is not set}"
: "${APT_GIT:?APT_GIT is not set}"
export DEBIAN_FRONTEND=noninteractive
sed -i \
    -e "s|^URIs: http://deb.debian.org/debian-security\$|URIs: http://snapshot.debian.org/archive/debian-security/${APT_SNAPSHOT}|" \
    -e "s|^URIs: http://deb.debian.org/debian\$|URIs: http://snapshot.debian.org/archive/debian/${APT_SNAPSHOT}|" \
    /etc/apt/sources.list.d/debian.sources
test "$(grep -c '^URIs: http://snapshot.debian.org/' /etc/apt/sources.list.d/debian.sources)" = 2
printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\n' > /etc/apt/apt.conf.d/99vmapp-snapshot
apt-get update -qq
cd /tmp
apt-get download -qq "git=${APT_GIT}"
deb=$(ls /tmp/git_*.deb)
mkdir -p /tmp/root
dpkg-deb -x "$deb" /tmp/root

# the shared libraries the runtime has, then the ones git's transports need (and patchelf, a build tool only)
find / -xdev \( -name '*.so' -o -name '*.so.*' \) 2>/dev/null | sort > /tmp/libs-runtime
apt-get install -y -qq --no-install-recommends libcurl3-gnutls libexpat1 patchelf > /dev/null

rm -rf /out/git
mkdir -p /out/git/bin /out/git/libexec/git-core /out/git/lib /out/git/share/git-core /out/git/share/doc/git
cp -a /tmp/root/usr/share/git-core/templates /out/git/share/git-core/templates
cp /tmp/root/usr/share/doc/git/copyright /out/git/share/doc/git/copyright
kept=0
left=''
for f in /tmp/root/usr/lib/git-core/*; do
    name=$(basename "$f")
    if [ -L "$f" ] || [ -d "$f" ]; then
        cp -a "$f" "/out/git/libexec/git-core/$name" # a builtin (a relative link to git), or mergetools/ (shell scripts)
        continue
    fi
    if head -c 4 "$f" | grep -q 'ELF'; then
        if ldd "$f" 2>&1 | grep -q 'not found'; then
            left="$left $name"
            continue
        fi
    elif head -n 1 "$f" | grep -q perl; then
        left="$left $name"
        continue
    fi
    cp -a "$f" "/out/git/libexec/git-core/$name"
    kept=$((kept + 1))
done
# links to the programs left out would dangle
for l in /out/git/libexec/git-core/*; do [ -e "$l" ] || { left="$left $(basename "$l")"; rm -f "$l"; }; done

# the libraries the runtime lacks: copied under their sonames, found through RUNPATH
libs=''
for f in /out/git/libexec/git-core/*; do
    [ -L "$f" ] || [ ! -f "$f" ] && continue
    head -c 4 "$f" | grep -q 'ELF' || continue
    needs=0
    for lib in $(ldd "$f" | awk '$2 == "=>" && $3 ~ /^\// { print $1 "=" $3 }'); do
        soname=${lib%%=*}
        real=$(readlink -f "${lib#*=}")
        if ! grep -qx "${lib#*=}" /tmp/libs-runtime && ! grep -qx "$real" /tmp/libs-runtime; then
            needs=1
            if [ ! -e "/out/git/lib/$soname" ]; then
                cp -L "${lib#*=}" "/out/git/lib/$soname"
                patchelf --set-rpath '$ORIGIN' "/out/git/lib/$soname"
                chmod 644 "/out/git/lib/$soname"
                libs="$libs $soname"
            fi
        fi
    done
    # (patchelf rewrites the file: its mode is set again)
    [ "$needs" = 1 ] && patchelf --set-rpath '$ORIGIN/../../lib' "$f" && chmod 755 "$f"
done
# the copyrights of the packages the libraries come from
for p in $(dpkg -S $(for s in $libs; do ls /usr/lib/*/"$s" /lib/*/"$s" 2>/dev/null | head -n 1; done) 2>/dev/null | cut -d: -f1 | sort -u); do
    mkdir -p "/out/git/share/doc/$p" && cp "/usr/share/doc/$p/copyright" "/out/git/share/doc/$p/copyright" 2>/dev/null || true
done

# git runs, and the transports resolve their added libraries from git/lib (RUNPATH comes before the system's directories, so this
# holds in the VM, where the system has none of them)
ln -s ../libexec/git-core/git /out/git/bin/git
GIT_EXEC_PATH=/out/git/libexec/git-core /out/git/bin/git --version
for f in /out/git/libexec/git-core/git-remote-https /out/git/libexec/git-core/git-http-fetch; do
    ldd "$f" | grep -q 'not found' && { echo "$f: a library is not found" >&2; exit 1; }
    ldd "$f" | awk '$3 ~ /^\// { print $3 }' | xargs -n1 readlink -f | grep -q '^/out/git/lib/' || { echo "$f does not use git/lib" >&2; exit 1; }
done
{
    echo "git ${APT_GIT} (Debian bookworm, snapshot.debian.org ${APT_SNAPSHOT}): $(sha256sum "$deb" | cut -d' ' -f1)  $(basename "$deb")"
    echo "kept: ${kept} programs and the builtins' links, with the HTTP transports; libraries added from the same snapshot (git/lib):${libs}"
    echo "left out (Perl modules the runtime does not have):${left}"
} | tee /out/git-stage.txt
du -sh /out/git
