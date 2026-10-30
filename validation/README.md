# DraftFork tests

Use Node 24 or later and an Equicord checkout with its dependencies installed. The tests reuse that checkout's `esbuild` and `diff`; React and jsdom are isolated test dependencies.

From this repository's root in PowerShell:

```powershell
$env:EQUICORD_DIR = 'C:\path\to\Equicord'
pnpm --dir validation/ui install --frozen-lockfile
node --test validation/draftFork-model.test.ts validation/draftFork-restore.test.ts validation/draftFork-storage.test.mjs validation/draftFork-live.test.mjs validation/ui/ui.test.mjs
```

The suite contains 80 tests: 9 model, 24 protected restore, 13 storage, 14 live adapter and 20 React interaction tests. Unicode fixtures intentionally include Vietnamese text to verify content preservation.

Discord components, stores and persistence are test doubles. Passing these tests does not replace testing in the live Discord composer. Equicord TypeScript, lint and build checks must be run from an Equicord checkout containing the plugin.
