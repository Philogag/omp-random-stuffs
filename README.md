# omp-random-stuffs

pnpm workspace monorepo.

## Layout

```
.
├── packages/
│   ├── core/            @omp/core — demo package, rename or replace
│   └── omp-omniroute-provider/  @philogag/omp-provider-omnirouter — OmniRoute provider + web tools
├── .omp-plugin/marketplace.json  omp marketplace catalog
├── pnpm-workspace.yaml  workspace globs (packages/*)
├── tsconfig.base.json   shared strict TypeScript settings
└── .npmrc               engine-strict, workspace-first resolution
```

Each package extends `tsconfig.base.json` and sets its own `rootDir`/`outDir`
(`src` → `dist`), because relative paths inside an extended config resolve
against the file that declares them, not the inheriting one.

## Commands

| Command            | Effect                                        |
| ------------------ | --------------------------------------------- |
| `pnpm install`     | install the whole workspace                   |
| `pnpm build`       | `tsc` every package that has a build script   |
| `pnpm typecheck`   | typecheck without emitting                    |
| `pnpm test`        | run tests in packages that define them        |
| `pnpm -F @omp/core add <dep>` | add a dependency to one package     |
| `pnpm -F @philogag/omp-provider-omnirouter test` | run one package's tests    |

## Marketplace

`.omp-plugin/marketplace.json` publishes every package under `packages/` as an
`omp` plugin. A package is marketplace-ready when its `package.json` carries an
`omp.extensions` (or `pi.extensions`) array; its directory name becomes the
catalog `source`.

Install this repo as a marketplace and add a plugin:

```bash
# local checkout (development)
omp plugin marketplace add ./

# or from GitHub once pushed
omp plugin marketplace add Philogag/omp-random-stuffs

omp plugin discover
omp plugin install omniroute-provider@omp-random-stuffs
```

Relative sources resolve against the marketplace root, so the same catalog works
for a local checkout and a cloned repository.

## Adding a package

1. `mkdir packages/<name>` with a `package.json` (`name`, `type: module`, `exports`).
2. Copy `packages/core/tsconfig.json` (adjust `rootDir`/`outDir` if needed).
3. Depend on a sibling with `"@omp/core": "workspace:^"` — no install step needed
   for the glob to pick it up.

## Requirements

Node >= 20, pnpm 12 (`packageManager` field pins it for Corepack).
