# Roborock Room Clean

A Homebridge plugin that adds a **fan in Apple Home for every room on your Roborock map**.

- **Turn the fan on** and the robot cleans that room.
- **The fan speed is the suction power**: 25% Quiet · 50% Balanced · 75% Turbo · 100% Max (optionally Max+ as a 5th step).
- **Vacuum only** (no mopping) and **2 passes** by default. Both can be changed.
- Change the speed while it cleans and the suction changes live.
- The fan stays on while the robot cleans and turns off when it's done. Turning it off sends the robot back to the dock.
- A routine or room clean started from the Roborock app shows in Apple Home too, on its switch or fan.
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

- Only routines you ticked in the Routines list have a switch to show it on. A room clean that matches no routine shows on the fan (or combination) for exactly those rooms.
- A whole-home clean shows on a routine that cleans the whole home. Zone cleans are not shown.
- The rooms of each routine are read when Homebridge starts: restart Homebridge after changing a routine in the Roborock app.
- While such a clean shows as on, turning that switch or fan off in Apple Home (also from a scene that turns everything off) stops the robot, and automations that react to the switch or fan turning on will run.
- The map is read through the Roborock cloud, normally once per clean (up to three tries when the robot is slow to mark the rooms; if it marks none, the plugin stops asking for ten minutes).
- Turn the feature off with `followExternal: false` ("Show cleans started outside Apple Home" under Routine switches).

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
| `language` | `en` | `en` or `he` (Hebrew): language of the settings page and of the default names |
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

Stored in `<homebridge storage>/roborock-room-clean/`: `auth.json` (the Roborock session), `home-cache.json`, `rooms-<robot>.json` and `routines-<robot>.json` (used when the cloud is unreachable at startup). `status-<robot>.json` keeps the last known battery level and dock state.

## Credits

Protocol details based on [python-roborock](https://github.com/Python-roborock/python-roborock) and [homebridge-roborock-matter](https://github.com/mathiashornbek/homebridge-roborock-matter). Not affiliated with Roborock.

## עברית

<div dir="rtl">

התוסף מוסיף לאפליקציית "בית" של Apple מאוורר לכל חדר במפה של שואב Roborock: הדלקת המאוורר מנקה את החדר, ומהירות המאוורר היא עוצמת השאיבה. אפשר להוסיף גם שילובי חדרים, ואת תוכניות העבודה מאפליקציית Roborock כמתגים. תוכנית עבודה שהופעלה מאפליקציית Roborock מוצגת כדלוקה גם ב"בית".

כדי לעבור לעברית: פתח את הגדרות התוסף ב-Homebridge ובחר **עברית** בתיבה **Language / שפה** שבראש העמוד, לחץ על שמירה והפעל מחדש את Homebridge.

</div>
