# Roborock Room Clean

A Homebridge plugin that adds a **fan in Apple Home for every room on your Roborock map**.

- **Turn the fan on** and the robot cleans that room.
- **The fan speed is the suction power**: 25% Quiet · 50% Balanced · 75% Turbo · 100% Max (optionally Max+ as a 5th step).
- **Vacuum only** (no mopping) and **2 passes** by default. Both can be changed.
- Change the speed while it cleans and the suction changes live.
- The fan stays on while the robot cleans and turns off when it's done. Turning it off sends the robot back to the dock.

It sends the room-clean command straight to the robot, so it does **not** use Roborock routines ("work plans") and the app's **10-routine limit does not apply**.

### Standalone and backup-friendly

- Pure Node.js, with no Python, no Home Assistant, no extra scripts and no other Homebridge plugin needed.
- The Roborock login, cached room list and each fan's last speed live inside Homebridge's own storage folder. A **Homebridge UI backup** includes all of it. After restoring a backup the plugin is reinstalled from npm and works again with no new login.

## Charging sensor and battery

For each robot the plugin also adds a **contact sensor**: **closed** while the robot is on the dock charging (or fully charged), **open** while it is off the dock. The same accessory shows the **battery level** (and a low-battery warning under 20%). Use it in automations, e.g. "when the vacuum leaves the dock". Set `chargingSensorName` to rename it, or `chargingSensor: false` to turn it off. The status is checked every 60 seconds (`statusInterval`).

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

## Files

Stored in `<homebridge storage>/roborock-room-clean/`: `auth.json` (the Roborock session), `home-cache.json` and `rooms-<robot>.json` (used when the cloud is unreachable at startup).

## Credits

Protocol details based on [python-roborock](https://github.com/Python-roborock/python-roborock) and [homebridge-roborock-matter](https://github.com/mathiashornbek/homebridge-roborock-matter). Not affiliated with Roborock.
