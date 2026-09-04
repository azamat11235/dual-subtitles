# Dual Subtitles for YouTube

An extension for Chrome and other Chromium browsers (Dia, Edge, Brave, Arc): it
shows **two subtitle tracks at once** on a video — English and Spanish, say. If
the video has no track in the second language, the extension produces one
itself: free, no keys required.

```
   I was a government major, which means I had to write a lot of papers.
   Estudie ciencias politicas, lo que significa que tuve que escribir
   muchos trabajos.
```

## Installing

1. Open `chrome://extensions` (in Dia — `dia://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the project folder.

That is all: on any video page a two-line button appears in the player controls.
The quick toggle is `Alt+D`.

## How the second language is chosen

The real question is what to do when the video simply has no track in the
language you want. The extension walks down this chain and stops at the first
thing that works:

| # | Source | Cost | Quality |
|---|--------|------|---------|
| 1 | An existing track in that language (manual preferred over automatic) | free | best |
| 2 | **YouTube's own translation** — the same request with a `tlang` parameter | free, **one** request for the whole video | good |
| 3 | Google Translate (free unofficial endpoint), in batches | free | good |
| 4 | DeepL — if you paste in a free key (500,000 characters a month) | free with a key | best of the machine ones |
| 5 | MyMemory | free, small daily quota | fair |

The key find: YouTube **already has** machine translation of subtitles into 150+
languages — the "Auto-translate" item in the player menu. It is switched on by a
single `tlang` parameter on the subtitle request, returns finished text with the
original timings, and needs neither keys nor third-party services. That is the
fastest and most reliable path, which is why it comes first. The other providers
are insurance for when YouTube answers `429` (its translation quota is separate
and fairly strict) or when a track is marked as not translatable.

Translations are cached in `chrome.storage.local` per video and language pair,
so watching something again costs no requests at all.

### Which track counts as "the video's language"

`videoDetails.defaultAudioLanguage` answers this when it is there, and on an
auto-dubbed video it is not — precisely where a guess costs the most, since such
a video carries one automatic caption track per dub, twenty of them, sorted
alphabetically by language name. Taking the first of those put Arabic on an
English video.

YouTube does say which one is the original: every entry of `audioTracks` points
its `defaultCaptionTrackIndex` at it. Failing both signals, a lone automatic
track names the spoken language, because YouTube only ever recognises speech in
the language actually spoken; several of them mean dubs, and then it says
nothing and the choice falls back to the first manual track.

## Why the two lines stay in step

Both lines are driven by **one timeline**. A segment holds the text of both
languages at once:

```js
{ start: 12559, end: 17039, primary: 'I was a government major', secondary: 'Estudie ciencias politicas' }
```

Every frame looks up exactly one segment and fills both lines from it, so the
lines cannot switch at different moments — the synchronisation is a property of
the data, not something the rendering has to keep arranging.

The timing of the first line defines the segments; the second line is mapped
onto them by `src/content/align.js`:

* **YouTube's translation** keeps the original timings, so cues are matched by
  start time. Matching by index would look simpler and be wrong: YouTube drops
  the odd cue from a translated track (an empty translation, a `[Music]` line),
  and from there on every index is off by one.
* **A separate track in another language** is an independent transcription with
  its own cue boundaries. It is matched by time overlap: a cue goes into every
  segment it meaningfully covers, and a cue that clears the bar nowhere still
  fills the segment it overlaps most rather than leaving a blank. The result is
  phrase-by-phrase correspondence, not word-for-word — a foreign track is not a
  translation of the first line, and it is not treated as one.
* **Machine translation** works on sentences and is mapped back through the cues
  each sentence was built from, so it fits either display granularity.

A segment whose translation came back empty keeps its place with an empty
string. Dropping it would shift every segment after it and pull the two lines
apart — exactly the failure this design exists to prevent.

### Why the text is merged into sentences first

Automatic subtitles are cut into three- or four-word fragments: "which means I
had to", "write a lot of". Translating those one by one is pointless — the
result is mush. So before translating, the cues are merged into meaningful
chunks (up to an end-of-sentence mark, a pause, 120 characters or 7 seconds),
the whole chunk is translated, and it stays on screen for its entire span. The
same chunks are the display unit for both lines; turning **Show whole
sentences** off falls back to raw cues, where the second line simply holds the
sentence translation across the cues it covers.

## How it works inside

The least obvious part is how to get the subtitle text at all.

The naive way — take `captionTracks[].baseUrl` from `ytInitialPlayerResponse`
and download it — **does not work today**: YouTube answers `HTTP 200` with an
empty body, because the request carries no `pot` (proof-of-origin) token and
`baseUrl` has none. Verified against live data:

```
baseUrl + &fmt=json3                  -> 200, 0 bytes
the URL the player requests itself    -> 200, 315 cues
```

So the extension watches the URL **the player itself** requests — that one has a
`pot`. It is visible straight from the isolated world through the Resource
Timing API, with no hooks on `fetch`. Then comes the pleasant part: the `lang`,
`name`, `kind` and `tlang` parameters are not part of the signature (`sparams`),
so one intercepted URL can fetch **any** track and any translation. If the
player has not loaded subtitles yet, the extension switches them on for a
moment through the player API, catches the request and puts everything back.

One parameter does not travel with the rest. `variant=timing-optimized` belongs
to the track: the original transcript is served without it, a transcript derived
from a dub only with it. Carry the captured value over to another language and
YouTube answers `200` with an empty body — the same way it refuses a request with
no `pot` at all. Measured on one video:

```
captured de-DE URL, as-is                 -> 194 cues
same URL with lang=en, variant kept       -> 200, 0 bytes
same URL with lang=en, variant removed    -> 164 cues
captured en URL with lang=de-DE           -> 200, 0 bytes
```

Since the intercepted URL may have come from either kind of track, both forms are
tried. Every strategy gets one attempt before any of them is retried: an empty
body means either a mismatched `variant` or rate limiting, and only the first is
cured by the next request, so pausing before reaching it would cost seconds on
the ordinary case.

```
src/
  page/inject.js            main world: player API and playerResponse
  content/
    util.js                 settings, small shared helpers
    parse.js                json3 parsing, sentence merging, active-cue lookup
    align.js                mapping the second language onto the first timeline
    select.js               which track feeds which line
    tracks.js               pot-URL interception, track list, subtitle fetching
    render.js               the overlay and the per-frame segment lookup
    ui.js                   the player button and the settings panel
    main.js                 orchestration: language choice and segment building
    overlay.css
  common/settings-form.js   settings form (shared by the panel and the popup)
  background/
    service-worker.js       translation providers, batching, cache
  popup/                    default settings
```

A few decisions worth knowing about before changing anything:

* **One timeline, two fields.** The second line is always mapped onto the
  segments of the first. There is no second independent cue list to drift.
* **Overlaps are trimmed.** In `json3` the durations of neighbouring events
  overlap, so a cue's end is cut at the start of the next one — otherwise two
  cues would hang on screen at once.
* **Service events are dropped.** On automatic tracks exactly half the events
  are `aAppend: 1` carrying a single line break, an artefact of the rolling
  caption. Verified on a real video: filtering them loses no text at all
  (670 events → 335 cues, 0 characters lost).
* **Translation batching verifies itself.** Google does not guarantee it will
  keep the `\n` split. If the number of lines in the answer does not match the
  number sent, the batch is halved and translated again — down to a single line,
  where a mismatch is impossible. A translation never ends up on the wrong cue.
* **The overlay hides during ads** — `currentTime` then belongs to the ad clip,
  not to the video.

## Settings

The panel opens from the button in the player (that is also where the current
video's track list is visible); the extension popup sets the defaults.

* languages of the first and second line, translator, DeepL key;
* size, offset from the bottom, backdrop opacity, colours, line order;
* hide YouTube's own subtitles;
* pause when the mouse is over the subtitles (handy when learning a language);
* show whole sentences instead of raw cues.

### Moving the subtitles

The block is dragged with the mouse, the way YouTube's own subtitles are. The
position is stored as fractions of the player size, so it survives a window
resize and the jump into fullscreen, and a block placed by hand is no longer
lifted when the control bar appears — the spot was chosen deliberately.

A drag only begins once the pointer has travelled a few pixels. Everything a
plain press used to do still works: a single click pauses or resumes the video,
a double click selects a word and a triple click the whole line, so looking up
an unfamiliar word is still one gesture away.

Dragging and the *offset from the bottom* slider steer the same thing, so moving
the slider drops a hand-picked position — otherwise the slider would look
broken. A **Put back** button appears in the panel once the subtitles have been
moved.

## Tests

```
npm test
```

63 tests with no dependencies: `json3` parsing against fixtures shaped like a
real response; sentence merging; active-cue lookup (checked against a full
scan); alignment of the second language onto the first timeline, including the
case where the translated track is missing a cue; track selection, built on the
real track list of an auto-dubbed video; the geometry that keeps a dragged block
inside the player; translation batching, provider order and the concurrency
limiter.

## Limitations

* If a video has no subtitles at all (not even automatic ones), there is nothing
  to work from — speech recognition in the browser is out of scope.
* Free translation endpoints can answer `429`. The extension retries with a
  growing pause and moves on to the next provider; for a steady result on long
  videos it is worth pasting in a free DeepL key.
* A track in another language is aligned to the first line by time, so it is a
  phrase-level match, not a word-for-word translation. For strict
  correspondence, set the second language to one the video has no track in — it
  is then translated from the first line.
* The watch page (`/watch`) is supported; Shorts and embedded players were not
  specifically tested.
