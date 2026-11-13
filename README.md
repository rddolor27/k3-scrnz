<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/lockup-on-dark.svg">
  <img alt="tri.scrnz" src="assets/brand/lockup-on-light.svg" width="360">
</picture>

# tri.scrnz

A lightweight Windows desktop app for testing Android devices over USB. It gives you one tab per device, with a clickable live mirror of the main screen, the customer screen when one is detected, and a filtered logcat panel.

Built with Tauri 2 (Rust and React/TypeScript). It talks to the adb server that is already running on `127.0.0.1:5037`, and it mirrors screens with scrcpy-server 5.0.1.

## Prerequisites

- Windows 10/11 with the WebView2 Runtime
- Visual Studio Build Tools 2022 ("Desktop development with C++")
- Rust stable with the MSVC toolchain (`rustup default stable-msvc`)
- Node.js 24 and pnpm 10
- Android SDK platform-tools. The app uses the SDK's adb server and never ships its own adb.

## Develop

```sh
pnpm install
pnpm tauri dev
```

## Build

```sh
pnpm tauri build
```

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`.

## License

tri.scrnz is licensed under the [Apache License 2.0](LICENSE). The installer ships `LICENSE` and `NOTICE` next to the app.

## Third-party

`src-tauri/resources/scrcpy-server-v5.0.1` is the unmodified server from [scrcpy](https://github.com/Genymobile/scrcpy) v5.0.1 (Copyright (C) 2018 Genymobile, Copyright (C) 2018-2026 Romain Vimont; Apache License 2.0). Its SHA-256 is `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`. See [NOTICE](NOTICE).
