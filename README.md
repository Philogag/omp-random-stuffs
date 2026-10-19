# omp-random-stuffs

pnpm workspace monorepo.

## Layout

```
.
├── packages/
│   ├── core/            @omp/core — demo package, rename or replace
│   └── omp-omniroute-provider/  @omp/omniroute-provider — OmniRoute provider + web tools
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
| `pnpm -F @omp/omniroute-provider test` | run one package's tests    |

## Adding a package

1. `mkdir packages/<name>` with a `package.json` (`name`, `type: module`, `exports`).
2. Copy `packages/core/tsconfig.json` (adjust `rootDir`/`outDir` if needed).
3. Depend on a sibling with `"@omp/core": "workspace:^"` — no install step needed
   for the glob to pick it up.

## Requirements

Node >= 20, pnpm 12 (`packageManager` field pins it for Corepack).
