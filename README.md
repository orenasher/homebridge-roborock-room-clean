# Roborock Room Clean

A Homebridge plugin that adds a **fan in Apple Home for every room on your Roborock map**.

- **Turn the fan on** and the robot cleans that room.
- **The fan speed is the suction power**: 25% Quiet · 50% Balanced · 75% Turbo · 100% Max (optionally Max+ as a 5th step).
- **Vacuum only** (no mopping) and **2 passes** by default. Both can be changed.
- Change the speed while it cleans and the suction changes live.
- The fan stays on while the robot cleans and turns off when it's done. Turning it off sends the robot back to the dock.
- A routine or room clean started from the Roborock app shows in Apple Home too, on its switch or fan.
- Optional **robot vacuum**: the robot itself in Apple Home, with the vacuum icon, through Matter. See [Robot vacuum (Matter)](#robot-vacuum-matter).
- Optional **map camera**: the robot's live map as a camera in Apple Home, in a colour style you choose. See [Map camera](#map-camera).
- Settings page in English or Hebrew.

It sends the room-clean command straight to the robot, so the room fans do **not** use Roborock routines ("work plans") and the app's **10-routine limit does not apply**.

The routines you do have in the Roborock app can be added too, each as a **switch**: you tick the ones you want in Apple Home. See [Routines](#routines).

### Standalone and backup-friendly

- Pure Node.js, with no Python, no Home Assistant, no extra scripts and no other Homebridge plugin needed.
- The Roborock login, cached room list and each fan's last speed live inside Homebridge's own storage folder. A **Homebridge UI backup** includes all of it. After restoring a backup the plugin is reinstalled from npm and works again with no new login.

## Charging sensor and battery

Every fan and routine switch also shows the robot's **battery level** and whether it is **charging** (on the dock): open its settings in Apple Home. Turn it off with `batteryOnFans: false`.

Status changes show up quickly: the robot reports them itself through the cloud connection, the plugin checks right after a fan starts or stops a clean, and it asks every 30 seconds while the robot is away from the dock (every `statusInterval` seconds on the dock).

For each robot the plugin also adds a **contact sensor**: **closed** while the robot is on the dock charging (or fully charged), **open** while it is off the dock. The same accessory shows the **battery level** (and a low-battery warning under 20%). Use it in automations, e.g. "when the vacuum leaves the dock". Set `chargingSensorName` to rename it, or `chargingSensor: false` to turn it off. Turn the sensor off if the battery on the fans is enough for you.

## Supported robots

Roborock robots that use the standard "1.0" protocol: S-series (S5 – S8 family), Q-series, Q Revo, Saros and similar. The 2025 Q7 series (B01 protocol) is not supported yet.

## Setup

1. Install **Roborock Room Clean** from the Homebridge UI (or `npm install -g homebridge-roborock-room-clean`).
2. Open the plugin settings, enter the email of your Roborock app account, press **Send code**, enter the code from the email and press **Log in**.
3. Choose the defaults and save.
4. Restart Homebridge. A fan appears in Apple Home for every room.

Tip: set **Fan name** to `ניקוי {room}` (any text with `{room}`) to get names like "ניקוי סלון".

## Rooms and combinations

The plugin settings show two lists above the regular options:

- **Rooms**: every room on the robot's map. Untick a room to remove its fan from Apple Home, and pick the number of passes for each room (or leave it on the default).
- **Room combinations**: extra fans that clean several rooms together. Each one can be edited or deleted, and has its own number of passes.

Press **Save** and restart Homebridge after changing them.

## Routines

The **Routines** list in the plugin settings shows every routine ("work plan") you made in the Roborock app. It is read live from your Roborock account, so a new routine shows up as soon as you open the settings.

- **Tick** a routine to add a switch for it to Apple Home. **Untick** it to remove the switch. Nothing is added until you tick it.
- **Turning the switch on** starts the routine, exactly like pressing it in the Roborock app, with the rooms and settings saved in the routine.
- The switch **stays on while the robot is cleaning** and turns off when it is done. **Turning it off** stops the robot and sends it back to the dock.
- Only one fan or routine switch per robot runs at a time: starting one turns the others off.
- Set **Switch name** (under "Routine switches") to e.g. `תוכנית {routine}` to add text around the routine name.

Press **Save** and restart Homebridge after changing the list. A routine keeps its switch when you rename it in the Roborock app.

Starting a routine goes through the Roborock cloud (routines are stored there), so it needs an internet connection. The room fans keep working over the home network.

## Cleans started outside Apple Home

A routine pressed in the Roborock app, a scheduled routine or a room clean started from another app shows in Apple Home too: the matching routine switch (or the fan for those rooms) turns on, and turns off when the clean ends. Turning it off in Apple Home stops the robot and sends it back to the dock.

The robot does not say which routine it is running, so the plugin reads from the robot's live map which rooms are being cleaned and compares them with the rooms saved in each routine. When two routines clean the same rooms, the one whose suction and water settings the robot is using is picked. When the robot is reachable on the home network this takes a few seconds: the robot reports by itself that it started, and the plugin then reads its status every few seconds until it knows what is running. Otherwise it shows at the next regular status check. A whole-home clean that has a whole-home routine switch needs no map at all. Notes:

- A fan that shows such a clean shows the suction the robot is really using. The speed the fan remembers for cleans started from Apple Home is not changed, and comes back when the clean ends.
- Only routines you ticked in the Routines list have a switch to show it on. A room clean that matches no routine shows on the fan (or combination) for exactly those rooms.
- A whole-home clean shows on a routine that cleans the whole home. Zone cleans are not shown.
- The rooms of each routine are read when Homebridge starts: restart Homebridge after changing a routine in the Roborock app.
- While such a clean shows as on, turning that switch or fan off in Apple Home (also from a scene that turns everything off) stops the robot, and automations that react to the switch or fan turning on will run.
- The robot sends its map to one viewer at a time: while the Roborock app is open on the map screen it does not answer the plugin. The plugin then reads the map the robot is sending to the app (the app's requests travel on the same account channel, with the key that map is encrypted with). If the Roborock cloud does not allow that, the room shows in Apple Home once the app is closed; the plugin keeps asking for about five minutes.
- The map is first asked for over the home network, in case the robot sends it there.
- A robot that is standing still with an unfinished clean (stuck, paused, charging in between) is not shown as cleaning.
- The map is read through the Roborock cloud, normally with a single request per clean.
- Turn the feature off with `followExternal: false` ("Show cleans started outside Apple Home" under Routine switches).

## Robot vacuum (Matter)

Turn on **Robot vacuum** in the plugin settings and the robot appears in Apple Home as a real **robot vacuum**, with the vacuum icon and Home's own vacuum screen:

- **Start, pause, resume, send to the dock**, with the robot's state (cleaning, paused, returning, charging, error) and its **battery**.
- **Rooms**: tick the rooms to clean. No rooms, or all of them, cleans the whole home.
- **Kind of clean**: vacuum, mop, or vacuum and mop (mopping only for robots that mop), and the **suction**: Home shows the levels as Quiet, Automatic (Balanced), Quick (Turbo) and Max. Changing it while the robot cleans takes effect at once.

Apple Home knows robot vacuums only through **Matter**. Homebridge 2 has Matter built in, so nothing else is installed; it only has to be turned on for the plugin's bridge. Homebridge publishes a robot vacuum on its own, with its own pairing code, apart from the plugin's bridge.

**Setting it up**

1. In the Homebridge UI, on the Plugins page, open this plugin's menu, choose **Child Bridge Config** and turn on **Enable Matter**. ("Externals Only (Matter)" can be turned on too.) If the plugin runs on the main bridge instead of a bridge of its own, turn Matter on for the main bridge in the Homebridge settings: Matter has to be on for the bridge the plugin runs on.
2. Turn on **Robot vacuum** in the plugin settings, save, and restart Homebridge. The settings page says whether Matter is on for the bridge.
3. The Homebridge log now has the lines `Commissioning codes for <robot>` with a **Manual Code**. In the Home app choose **Add Accessory > More options**, pick the vacuum and enter that code.

**How it fits with the rest**

- The fans, routine switches, charging sensor and map camera stay exactly as they are; use whichever you like.
- A clean started from the vacuum also shows on the fan (or routine switch) of exactly those rooms, unless `followExternal` is turned off. A clean started from a fan, a routine switch or the Roborock app shows on the vacuum.
- Home's line under the vacuum names the room being cleaned. For several rooms it names the first one until the robot itself says where it is (newer robots do); for the whole home it names none.
- One room is cleaned with the passes set for that room; several rooms with the default `repeat`; the whole home the way the robot itself is set.
- With `restoreSettings` (the default) the robot's own suction and water setting are put back when a clean started from the vacuum ends.
- **Stop** stops the robot where it is. **Send to dock** takes it home.

Good to know:

- Home takes the list of kinds of clean on the day the vacuum is added. The list follows `enableMaxPlus`, so set that first. A level added later shows after you remove the vacuum from the Home app and add it again; a level that was offered once stays offered.
- The vacuum is published once the robot has answered and its rooms are known. A robot without rooms on its map is not published: Home does not take a robot vacuum without rooms.
- What Homebridge holds for the vacuum is compared with the robot every minute and put right when it differs, so a missed update does not stay.
- The battery percentage under the vacuum can stay behind in the Home app: Matter does not send its changes, and Home reads it only now and then. After every Homebridge start the plugin shows it as unknown for a moment and then as it is, so Home takes the real value the next time it reads it. The fans and the charging sensor always show the current battery.
- Matter support in Homebridge is new. If the vacuum shows "No Response", check the Homebridge log first; restarting the Apple device that shows it has helped others.
- If the vacuum cannot be published, the log says so once and everything else in the plugin goes on working.
- Turning `matterVacuum` off stops publishing the vacuum; remove it in the Home app too.

## Map camera

Turn on **Map camera** in the plugin settings and the robot's map appears in Apple Home as a **camera**: the rooms in colour with their names, the walls, the path the robot drove, where it is now, its dock, the no-go zones from the Roborock app, and a status line (what the robot is doing, battery, area and time of the clean). While rooms are being cleaned, those rooms stand out and the others are toned down.

The plugin reads the map from the robot and draws the picture itself, in plain Node.js. There is no Python, no other plugin and no script behind it.

- **Colour styles**: Roborock, Bright, Night, Pastel, Blueprint, Grey, Sand and Neon. The settings page shows a live preview, drawn from your own map once the plugin has read it.
- **Your own colours**: replace the background, walls, path, robot, dock and text colours of a style, and give any room its own colour. Rooms you leave alone get colours from the style so that rooms next to each other differ.
- **Turn the map** in quarter turns, and choose whether the room names and the status line are drawn.
- **Leave out what lies beyond a virtual wall**: a robot's laser sees through windows and into mirrors, which adds a patch of floor outside the home and makes the home itself smaller in the picture. With this option on, what lies beyond a virtual wall drawn in the Roborock app is not drawn: floor the robot cannot drive to because of the wall, and a patch that hangs on to the home only across the wall (a window is itself a wall on the map). Draw the virtual wall between the home and the patch, longer than the place where they touch. Only a piece of a room is ever left out: a whole room closed off by a virtual wall stays on the map. The Homebridge log says what was left out, or why nothing was.
- **Carpets** the robot has found are marked with fine stripes (`mapCarpets: false` turns that off). The robot does not send them with every map, so the plugin keeps the ones it saw last.
- The tile in Apple Home shows the latest picture; opening the camera shows the map live while the robot drives.

**Adding it to Apple Home.** Cameras are separate accessories in HomeKit, so the camera is added once by hand: after saving and restarting Homebridge, open the Home app, choose **Add Accessory > More options**, pick the camera (named after the robot, for example "S8 Map") and enter the setup code of this plugin's bridge, the one shown next to the plugin's QR code in Homebridge.

**ffmpeg.** The live view is video, and video is made by `ffmpeg` on the Homebridge computer, as for every camera in Homebridge. It is the one thing the camera uses that is not part of the plugin. The plugin looks for it in this order: the `ffmpegPath` setting, a copy that came with another camera plugin (`ffmpeg-for-homebridge`), the system's own. On a Raspberry Pi it is installed with `sudo apt install -y ffmpeg`. Without ffmpeg the camera still works as a picture that refreshes every few seconds; the log says so at start. If the copy found is the one of another camera plugin, the live view stops working when that plugin is removed, so installing ffmpeg on the computer itself is the safer choice. Apart from ffmpeg for the live view, the plugin needs no other plugin and no script.

**How often the robot is asked.** Only while somebody is looking: every 5 seconds while the camera is open and the robot is driving (once a minute while it stands still), and each time Apple Home refreshes the tile. One more read is done when a clean ends, so the tile shows the finished clean. The last map is kept on disk, so there is a picture right after a restart.

Good to know:

- The robot sends its map to one viewer at a time. While the Roborock app is open on the map, the camera keeps showing the last map (the status line says from when it is) and catches up when the app is closed.
- Room names are written in Latin, Greek, Cyrillic and Hebrew letters. A name in another script is left off the map; the room is still drawn.
- The picture is as wide or as tall as your home, between 3:4 upright and 16:9 wide.
- Turning `mapCamera` off stops the camera; remove it in the Home app too, or it stays there as "No Response".

## Language (English / עברית)

The **Language** box at the top of the plugin settings switches the settings page between English (the default) and Hebrew, right-to-left. Hebrew also changes the names the plugin makes up itself for new installs (`ניקוי {room}`, `טעינת S8`). Names you typed and names from the Roborock app are never changed, and the Homebridge log stays in English.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `nameTemplate` | `Clean {room}` | Fan name, `{room}` = room name from the Roborock app |
| `autoRooms` | `true` | Create a fan for every room |
| `suction` | `max` | Starting fan speed: `quiet`, `balanced`, `turbo`, `max`, `max_plus`. After that each fan remembers the last speed you set |
| `enableMaxPlus` | `false` | Adds Max+ as the top step (20/40/60/80/100%). Only for robots that have Max+ |
| `mopMode` | `vacuum_only` | `vacuum_only` or `unchanged` (use the robot's current water setting) |
| `repeat` | `2` | Passes, 1–3 |
| `restoreSettings` | `true` | Put the previous suction/water setting back when the clean ends |
| `excludeRooms` | — | Rooms that should not get an automatic fan |
| `roomSettings` | — | Per-room overrides: `[{ "room": "Kitchen", "repeat": 1 }]`. Rooms not listed use `repeat` |
| `programs` | — | Extra fans: `{ "name", "rooms": [...], "suction", "mopMode", "repeat" }`. No rooms = every room |
| `routines` | — | Routines shown as switches: `[{ "name": "Kitchen" }]`. Managed from the Routines list; the list also saves each routine's `id` |
| `routineNameTemplate` | `{routine}` | Switch name, `{routine}` = routine name from the Roborock app |
| `followExternal` | `true` | Show cleans started outside Apple Home on the matching switch or fan |
| `language` | `en` | `en` or `he` (Hebrew): language of the settings page, of the default names and of the texts on the map |
| `matterVacuum` | `false` | Add the robot as a [robot vacuum](#robot-vacuum-matter) through Matter |
| `matterVacuumName` | the robot's name | Name of the robot vacuum |
| `mapCamera` | `false` | Add the [map camera](#map-camera) |
| `mapCameraName` | `<robot> Map` | Name of the camera |
| `mapTheme` | `roborock` | Colour style: `roborock`, `light`, `dark`, `pastel`, `blueprint`, `mono`, `sand`, `neon` |
| `mapColors` | — | Own colours on top of the style, as `#rrggbb`: `background`, `walls`, `path`, `robot`, `dock`, `text`, `textBack` |
| `mapRoomColors` | — | A colour for single rooms: `[{ "room": "Kitchen", "color": "#f6c667" }]` |
| `mapRotation` | `0` | Turn the map: `0`, `90`, `180` or `270` degrees clockwise |
| `mapLabels` | `true` | Write the room names on the map |
| `mapStatus` | `true` | Show the status line |
| `mapCarpets` | `true` | Mark carpets with fine stripes |
| `mapHideBeyondWalls` | `false` | Leave out what lies beyond a virtual wall (for floor "seen" through a window) |
| `ffmpegPath` | — | Where ffmpeg is, when it is not found by itself (map camera live view) |
| `skipDevices` | — | Robots to ignore |

Example:

```json
{
  "platform": "RoborockRoomClean",
  "name": "Roborock Room Clean",
  "nameTemplate": "ניקוי {room}",
  "suction": "max",
  "mopMode": "vacuum_only",
  "repeat": 2,
  "programs": [
    { "name": "מטבח ופינת אוכל", "rooms": ["מטבח", "פינת אוכל"] }
  ]
}
```

## Notes

- Room names are read from the robot when Homebridge starts. After renaming, splitting or merging rooms in the Roborock app, restart Homebridge.
- Turning a fan on while the robot is already cleaning stops the current job and starts the new one. Only one fan per robot runs at a time.
- Siri: "Turn on Clean Living Room", "Set Clean Living Room to 100%".
- If you also use another plugin that shows the same routines in Apple Home, tick only the ones you want from this plugin so they do not appear twice.

## Files

Stored in `<homebridge storage>/roborock-room-clean/`: `auth.json` (the Roborock session), `home-cache.json`, `rooms-<robot>.json` and `routines-<robot>.json` (used when the cloud is unreachable at startup). `status-<robot>.json` keeps the last known battery level and dock state, `vacuum-<robot>.json` what the robot vacuum in Apple Home was set to (rooms, kind of clean) and which kinds of clean it was published with, `map-<robot>.bin` the last map read for the map camera, and `listen.json` remembers that Roborock's cloud refused the listening described under [Cleans started outside Apple Home](#cleans-started-outside-apple-home), so it is not tried at every start (it is forgotten when you log out or in). None of these has to be restored for the plugin to work: whatever is missing is read again from Roborock. They are all part of a Homebridge UI backup, and so is the pairing of the robot vacuum (Homebridge keeps it in its own `matter` folder); restore them together.

## Credits

Protocol details based on [python-roborock](https://github.com/Python-roborock/python-roborock) and [homebridge-roborock-matter](https://github.com/mathiashornbek/homebridge-roborock-matter). The letters on the map are drawn from [Liberation Sans](https://github.com/liberationfonts) (SIL Open Font License, see `lib/glyphs-LICENSE.txt`). Not affiliated with Roborock.

## עברית

<div dir="rtl">

התוסף מוסיף לאפליקציית "בית" של Apple מאוורר לכל חדר במפה של שואב Roborock: הדלקת המאוורר מנקה את החדר, ומהירות המאוורר היא עוצמת השאיבה. אפשר להוסיף גם שילובי חדרים, ואת תוכניות העבודה מאפליקציית Roborock כמתגים. תוכנית עבודה שהופעלה מאפליקציית Roborock מוצגת כדלוקה גם ב"בית".

**תלויות**: התוסף לא צריך שום תוסף או סקריפט אחר. הדבר היחיד מבחוץ הוא ffmpeg, ורק לשידור החי של מצלמת המפה (התמונה עצמה עובדת גם בלעדיו). אם ffmpeg מגיע מתוסף מצלמה אחר, השידור החי יפסיק כשמסירים את התוסף ההוא, ולכן עדיף להתקין אותו במחשב עצמו: `sudo apt install -y ffmpeg`.

**שואב רובוטי (Matter)**: בהגדרות התוסף אפשר להוסיף את הרובוט עצמו ל"בית" כשואב רובוטי, עם האייקון של השואב: הפעלה, השהיה, שליחה לעמדת הטעינה, בחירת חדרים, שאיבה או שטיפה ועוצמת השאיבה, וסוללה. נדרש Homebridge 2 עם Matter מופעל בגשר של התוסף (Child Bridge Config > Enable Matter). את השואב מצמדים פעם אחת עם ה-Manual Code שמופיע בלוג של Homebridge. עצירה מהשואב עוצרת את הרובוט במקומו, ו"שלח לעמדת הטעינה" מחזיר אותו לעמדה.

**מצלמת מפה**: בהגדרות התוסף אפשר להוסיף ל"בית" מצלמה שמציגה את המפה של הרובוט: החדרים בצבעים עם השמות שלהם, המסלול שהרובוט עבר, איפה הוא נמצא ושורת מצב. בוחרים סגנון צבעים מתוך שמונה, ואפשר לקבוע צבעים משלך וצבע לכל חדר. התוסף מצייר את המפה בעצמו, בלי תוסף או סקריפט נוסף. את המצלמה מוסיפים ל"בית" פעם אחת: הוסף אביזר > אפשרויות נוספות, בוחרים את המצלמה ומזינים את קוד ההתקנה של הגשר של התוסף.

כדי לעבור לעברית: פתח את הגדרות התוסף ב-Homebridge ובחר **עברית** בתיבה **Language / שפה** שבראש העמוד, לחץ על שמירה והפעל מחדש את Homebridge.

</div>
