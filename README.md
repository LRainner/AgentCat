# Agent Cat

<p align="center">
  <img src="assets/app-icon.svg" width="128" height="128" alt="Agent Cat icon" />
</p>

<p align="center">
  <strong>An animated desktop companion for AI agents.</strong>
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

Agent Cat brings AI agent activity to life through animated desktop pets and real-time status updates. It is designed as an agent- and platform-independent companion, with Codex on macOS as the first supported integration.

> **Current status:** Agent Cat is under active development. The current version supports macOS 12 or later and integrates with Codex. Support for more agents and operating systems is planned.

## Highlights

- Animated desktop pets with click, double-click, drag, idle, and pointer-following reactions
- Real-time agent state displayed beside the pet without expanding its clickable area
- Configurable size, opacity, always-on-top behavior, mouse passthrough, and position locking
- Menu bar controls, launch at login, a settings window, and an animation debugger
- Codex-compatible v1 and v2 pet packs, including all nine standard animations and 16 v2 look directions
- Pet discovery from installed ChatGPT/Codex apps, `~/.codex/pets`, and user-selected directories
- On-demand access to locally installed pet assets without copying or redistributing them
- A built-in original fallback pet when no compatible pet pack is available

## Codex integration

Agent Cat can react to Codex sessions through command hooks. The settings window can install, repair, test, and remove the integration while preserving hooks owned by other tools.

The integration currently recognizes session, prompt, tool, subagent, compaction, permission, and stop events. Live status and task summaries can be enabled independently.

## Pet packs

Each pet lives in its own directory and contains a `pet.json` manifest plus a PNG or WebP spritesheet:

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "An optional description",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.png"
}
```

The current renderer supports the Codex-compatible sprite layout:

- Cell size: `192 × 208`
- v1 sheet: `8 × 9` cells (`1536 × 1872`)
- v2 sheet: `8 × 11` cells (`1536 × 2288`)
- `spriteVersionNumber` may be `1` or `2`; omitting it selects v1

Place custom packs in `~/.codex/pets` or add another directory from Settings.

## Development

### Requirements

- macOS 12 or later
- Node.js 20.19 or later
- A stable Rust toolchain
- Xcode Command Line Tools

### Run locally

```bash
npm install
npm run tauri -- dev
```

Right-click the pet to open Settings. Auxiliary windows can also be opened from the command line:

```bash
agent-cat --settings
agent-cat --pet-debug
```

### Test and build

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

## Project structure

```text
assets/       Original application and menu bar artwork
fixtures/     Deterministic pet packs used by automated tests
src/          HTML, TypeScript, CSS, and frontend tests
src-tauri/    Rust backend, Tauri configuration, and platform icons
```

## Privacy

Agent Cat processes Codex events locally. By default, its hook helper extracts the session ID, hook event name, and a sanitized tool name from the hook payload, sends the resulting event through a local Unix domain socket, and exits immediately.

When task summaries are enabled, Agent Cat keeps at most the first non-empty prompt line, truncated to 80 characters, in memory for live display. It does not store the summary in its configuration, logs, or history.

Agent Cat does not collect or persist full prompts, tool arguments, file contents, transcripts, terminal output, token usage, or model information. It does not maintain an activity history or send this data to a remote service.

## Roadmap

- Additional AI agent adapters
- Windows and Linux support
- A documented, agent-neutral event adapter interface
- A standalone pet-pack specification and authoring workflow

Contributions and ideas are welcome while the project takes shape.
