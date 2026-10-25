# Vidbox production releases

VideoStar (FrameForge) serves at `http://192.168.4.196:3060` from
`V:\Evergreen\apps\videostar`. Windows task `Evergreen VideoStar` runs
`V:\Evergreen\apps\run_vidbox_videostar_server.ps1` using portable Node
24.16.0. The worker is separate from the web app; rebuilding the app does not
require restarting ComfyUI.

## Release checklist

1. Enter the Evergreen House and claim `area:videostar`. Check the app, worker
   queues and live source before making changes.
2. Pin GitHub main. Compare the live working files with that commit, ignoring
   Windows line endings for text. Preserve and reconcile any live-only features
   in an isolated checkout. Do not discard them with a pull/reset.
3. Back up the live tracked source, added source files, Git metadata, `.next`,
   launcher and local configuration on Vidbox. Keep configuration backups on
   that host; never commit `.env.local` or its backup variants.
4. Validate the combined source: TypeScript, changed-file lint, lane/template
   validators, and the tests covering changed behavior. For WAN fixes run both
   `scripts/wan-frames.test.mts` and `scripts/matte-alpha-mask.test.mts` with
   `tsx` and ffmpeg available. Run the private-worker release suite from
   `.github/workflows/private-images.yml` when reconciling that package.
5. Build in an isolated Windows staging directory with the production Node
   runtime and pinned dependencies. Do not use the serving `.next` directory
   for the first build attempt. Merge the validated release to GitHub main.
6. Transfer the exact merged source tree, preserving local configuration,
   history, outputs and dependencies. Use `evctl deploy videostar --files`
   for the final production build and scheduled-task restart. Check queues
   immediately before restarting. Retain the old build until validation passes.
7. Compare **every tracked file** with the merged Git tree, then advance the
   live checkout/index to that same commit without deleting local files.
   Record the deployed commit and `.next/BUILD_ID`, and confirm the homepage
   actually serves that build ID. `evctl verify videostar` checks service
   health, lanes and task state, but alone does not prove source/build parity.
8. Check affected routes and worker capability preflights. Compare the installed
   private-worker package separately: its source directory is under the active
   ComfyUI runtime, not the app's `comfy-nodes` mirror. If already identical,
   leave that running worker intact.
9. Save a deployment receipt with commit, source comparison, build ID, test
   results and rollback location; release the House claim.

## Rollback

Keep a backup under `V:\Evergreen\backups` for each release. If the new app
fails, stop `Evergreen VideoStar`, restore the prior tracked source, Git
metadata and `.next` from that release's backup, then start the same task.
Do not replace user history or outputs. Verify `/`, `/api/lanes`, the restored
build ID and the task state. The app has no `/api/health` route.

## October 24, 2026 reconciliation

The serving checkout was based on `1af219a` with later manual overlays. The
release preserves FastH3/Ming and the FLUX 3/MOSS workflows, brings in main's
MATTE alpha-plane handoff, and integrates PR #7's source-derived WAN frame
length. WAN derives length on the 4n+1 grid without padding beyond a known
driver; explicit frame requests retain their existing behavior. Drivers over
161 frames require trimming or an explicit capped frame request. Header-probe
failure still falls back to 81 with a server log. Mask length is not checked
against driver length by this change.
