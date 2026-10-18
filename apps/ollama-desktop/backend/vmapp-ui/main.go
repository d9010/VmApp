//go:build linux

// Derived from app/cmd/app/app.go of Ollama v0.35.0 (https://github.com/ollama/ollama, MIT licence, Copyright (c) Ollama; the licence
// text is bundled as bin/LICENSE.ollama): the setup of the store, the server supervisor, the UI server and the shutdown are that file's
// lines; everything about a desktop is left out. INV-G4: this notice names the source.
//
// Command vmapp-ui is Ollama's desktop app without the desktop: the app's own Go backend (app/ui: chats, settings, cloud and model
// endpoints, the store) and the app's own supervisor of `ollama serve` (app/server), run headless on the VM's loopback. It is
// app/cmd/app/app.go (v0.35.0) with the webview, the tray, the updater and the macOS/Windows installer logic left out, and nothing else
// changed: the same ui.Server, the same store, the same server.Server.
//
// It is built inside the Ollama source tree (apps/ollama-desktop/build.sh copies this directory to app/cmd/vmapp-ui), never on its own.
//
// Environment (set by the app's core, apps/ollama-desktop/core/main.js):
//
//	VMAPP_OLLAMA_UI_ADDR    listen address, default 127.0.0.1:11501 (loopback only: the program refuses anything else)
//	VMAPP_OLLAMA_UI_TOKEN   the token the "token" cookie of every request must carry (ui.Server.Token); a random one if unset
//	VMAPP_OLLAMA_DB         path of the app's SQLite database (chats, settings), default $HOME/.ollama/app/db.sqlite
//	OLLAMA_HOST, OLLAMA_*   inherited by the `ollama serve` that app/server starts (see app/server/server.go cmd())
//	PATH                    must contain the `ollama` binary: app/server finds it with exec.LookPath
//
// It prints one line on stdout when it listens, `VMAPP-UI listening ADDR`; everything else goes to stderr as slog text lines.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/ollama/ollama/app/server"
	"github.com/ollama/ollama/app/store"
	"github.com/ollama/ollama/app/tools"
	"github.com/ollama/ollama/app/ui"
)

func main() {
	level := slog.LevelInfo
	if v := os.Getenv("OLLAMA_DEBUG"); strings.EqualFold(v, "true") || v == "1" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level:     level,
		AddSource: true,
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == slog.SourceKey {
				source := attr.Value.Any().(*slog.Source)
				source.File = filepath.Base(source.File)
			}
			return attr
		},
	})))

	addr := os.Getenv("VMAPP_OLLAMA_UI_ADDR")
	if addr == "" {
		addr = "127.0.0.1:11501"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		fmt.Fprintf(os.Stderr, "vmapp-ui: VMAPP_OLLAMA_UI_ADDR must be a loopback address with a port, got %q\n", addr)
		os.Exit(2)
	}
	token := os.Getenv("VMAPP_OLLAMA_UI_TOKEN")
	if token == "" {
		token = uuid.NewString()
	}

	st := &store.Store{DBPath: os.Getenv("VMAPP_OLLAMA_DB")}
	if st.DBPath == "" {
		home, _ := os.UserHomeDir()
		st.DBPath = filepath.Join(home, ".ollama", "app", "db.sqlite")
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		slog.Error("failed to listen", "addr", addr, "error", err)
		os.Exit(1)
	}

	// ctx is the app-level context; octx is the context of the supervised `ollama serve` (as in app/cmd/app/app.go).
	ctx, cancel := context.WithCancel(context.Background())
	octx, ocancel := context.WithCancel(ctx)

	done := make(chan error, 1)
	osrv := server.New(st, false)
	go func() {
		slog.Info("starting ollama server")
		done <- osrv.Run(octx)
	}()

	uiServer := ui.Server{
		Token: token,
		// Settings that the server reads when it starts (context length, models folder, expose, cloud) restart it.
		Restart: func() {
			ocancel()
			<-done
			octx, ocancel = context.WithCancel(ctx)
			go func() {
				done <- osrv.Run(octx)
			}()
		},
		Store:        st,
		ToolRegistry: tools.NewRegistry(),
		Logger:       slog.Default(),
		// No updater: the app is updated as a vmapp package. A nil Updater is handled by ui.Server.
	}

	srv := &http.Server{Handler: uiServer.Handler()}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Warn("ui server", "error", err)
		}
	}()
	fmt.Printf("VMAPP-UI listening %s\n", ln.Addr())

	if completed, err := st.HasCompletedFirstRun(); err != nil {
		slog.Error("failed to load has completed first run", "error", err)
	} else if !completed {
		if err := st.SetHasCompletedFirstRun(true); err != nil {
			slog.Error("failed to set has completed first run", "error", err)
		}
	}

	// Like the desktop app: once the server answers, refresh the signed-in user (a no-op without a key or without ollama.com).
	go func() {
		if err := ui.WaitForServer(ctx, 30*time.Second); err != nil {
			slog.Warn("ollama server not ready, continuing anyway", "error", err)
			return
		}
		if _, err := uiServer.UserData(ctx); err != nil {
			slog.Warn("failed to load user data", "error", err)
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	slog.Info("received SIGINT or SIGTERM signal, shutting down")

	shutdown, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	_ = srv.Shutdown(shutdown)
	cancel()
	select {
	case <-done:
	case <-time.After(6 * time.Second):
		slog.Warn("ollama server did not stop in time")
	}
}
