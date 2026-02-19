# QuestAutocompleter

A Vencord plugin that automatically accepts and completes Discord quests.

It keeps a queue of active quests and processes them one-by-one, handling things like reloads, account switches, and mid-session enabling so it doesn’t break or double-run.

## Features

* Auto-complete supported quest types
* Optional auto-accept for new quests
* Queue system to avoid conflicts
* Handles reloads and account switching
* Console logging for progress/debugging

## Supported Tasks

* WATCH_VIDEO
* WATCH_VIDEO_ON_MOBILE
* PLAY_ON_DESKTOP
* STREAM_ON_DESKTOP
* PLAY_ACTIVITY

Some tasks require the Discord desktop app and will be skipped on web.

## Installation

1. Put `QuestAutocompleter.tsx` in your Vencord plugins folder
2. Rebuild Vencord using `pnpm build` in your Vencord folder
3. Enable the plugin in the plugin manager
4. (Optional) turn on auto-accept in settings

Note: Vencord must be built from source in order to use this plugin. For more information, check out: https://docs.vencord.dev/installing/

## Credit

The original quest completion logic was based on:
https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb

The rest of the plugin (queueing system, session handling, auto-accept logic, etc.) was built and expanded on top of that idea.

## License

GPL-3.0 (same as Vencord)

