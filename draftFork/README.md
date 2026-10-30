# DraftFork

Save named versions of an unsent message, create variants, compare changes and restore a version after saving the current text. The interface is in English. Existing saved names and text are preserved.

## Install

DraftFork is a separate Equicord userplugin. Copy only this `draftFork` folder into an Equicord source checkout at `src/userplugins/draftFork`, then run the checkout's usual install and build commands:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Follow Equicord's injection instructions if Discord is not already using that checkout. Fully close and reopen Discord, then enable **DraftFork** in **Settings > Equicord > Plugins**.

The repository's root `index.tsx` and `styles.css` belong to DraftNavigator. They are not part of this plugin. DraftFork uses Equicord APIs and its existing `diff` dependency; it does not run as a standalone application.

## Use

1. Write in the main chat composer and open DraftFork with the two-page button.
2. Enter a name and choose **Save checkpoint**. The composer stays unchanged.
3. Select a checkpoint, choose **Create variant**, edit the name and text, then **Save variant**. Variants stay separate from the composer until restored.
4. Review the comparison. Crossed-out lines are removed from the current draft; underlined lines come from the selected checkpoint. Choose **Refresh comparison** after editing the composer.
5. Choose **Save current draft and restore**. DraftFork first saves the current text as **Before restore**, then checks the current account, channel and draft again before restoring.
6. To recover the previous text, select **Before restore** and restore it.

DraftFork never sends messages. Check the composer before sending anything yourself.

## Limits and storage

- Text in the main composer only. Finish message edits, cancel replies and slash commands, and remove attachments before saving or restoring.
- Each account/channel history holds 50 checkpoints, including variants and recovery copies. Nothing is evicted automatically. Restoring needs a free slot for recovery.
- Names allow 80 UTF-16 code units. Stored text allows 20,000 units; new variants and restores allow 4,500. Some emoji occupy multiple units.
- Empty text can be restored after a warning. Unsaved variants can be lost when switching accounts/channels or disabling the plugin.
- Restore stops if the context changes or the window closes while recovery is being saved. Recovery storage and Discord draft updates are separate operations.

Checkpoints use Equicord's shared default DataStore, with keys separated by account and channel. They may be included in Cloud Sync V2 pushes and full/DataStore backups. Other plugins can read the shared store; DraftFork adds no encryption.

**Export backup** saves JSON containing unsent text, names, relationships, timestamps and account/channel IDs. Keep exports private. There is no import button; text can be copied out of the JSON manually.

## Review and testing

The `validation` folder contains model, recovery, storage, Discord adapter and React interaction tests. See [test instructions](../validation/README.md).

Automated checks use simulated Discord components and stores. Full manual testing and complete human code review remain pending. This userplugin has not been approved for inclusion in Equicord.

For a manual smoke test, save A, write B, restore A and recover B from **Before restore**. Also check variants, empty and Unicode text, blocked composer states, account/channel switches, restart persistence, limits and export.

License: GPL-3.0-or-later. See [LICENSE](LICENSE).
