# Changelog

Notable changes per version. Older versions (before 1.7.0) are in the git history.

## 1.14.1

- the experimental child lock on the robot vacuum is removed again: Apple Home showed the keypad lockout's cluster as a temperature unit ("physical display"), not as a child lock; the child lock switch stays as it was

## 1.14.0

- experimental: `vacuumChildLock` puts the robot's child lock on the robot vacuum in Apple Home (Locked / Unlocked), kept in step with the child lock switch; off by default
- the child lock is read once per robot and shared by the switch and the vacuum

## 1.13.9

- the rooms done in a clean in progress are kept on disk: after a restart of Homebridge (an update, a crash) in the middle of a clean, they are shown done again in Apple Home when the robot is still in the same clean
- going on after being sent home is recognised only from the robot's own way home with its clean time known, so "send to dock" from Home and a new clean started on the way home stay as before

## 1.13.8

- a clean sent home in the middle (the home button on the robot, the Roborock app) and told to go on before it reached the dock keeps its progress: the rooms already done stay done in Apple Home, instead of starting over as a new clean

## 1.13.7

- the vacuum's battery refresh keeps the percentage unknown for 12 seconds before the real value, so Matter reports both steps to Apple Home; each refresh is written in the log

## 1.13.6

- the vacuum's battery percentage in Apple Home is refreshed every 5 percent (at most every 10 minutes), not only after a restart

## 1.13.5

- settings schema: required fields listed the JSON Schema way; keywords declare HAP and Matter support; ffmpeg from ffmpeg-for-homebridge found without loading that package

## 1.13.4

- donation link (PayPal)

## 1.13.3

- the vacuum's rooms survive a stop on the dock to charge in the middle of a clean: rooms done stay done, and the clean goes on from there

## 1.13.2

- plugin icon, changelog, supported Node.js versions listed

## 1.13.1

- a room counts only after the robot stayed in it

## 1.13.0

- the vacuum's room line follows the robot on the map

## 1.12.1

- docs - no "Externals Only (Matter)" in Homebridge 2.4; explain the empty Matter bridge

## 1.12.0

- optional child lock switch

## 1.11.0

- optional cleaning, returning and stopped sensors

## 1.10.1

- map camera - larger status line; lightning bolt on the battery while on the dock

## 1.10.0

- map camera - late maps shown at once, faster retries while cleaning, fresh cloud identity

## 1.9.9

- map camera - reconnect to the cloud after a long run of missing maps; say why maps fail

## 1.9.8

- a room clean is sent again without its passes only when the robot refuses them

## 1.9.7

- map camera - a map that does not come over the home network opens the connection afresh

## 1.9.6

- robot vacuum - battery re-sent once per start again

## 1.9.5

- robot vacuum - the battery percentage follows the robot

## 1.9.4

- say where ffmpeg comes from and that nothing else is needed

## 1.9.3

- robot vacuum - a clean started from a fan or the app shows its own rooms

## 1.9.2

- robot vacuum - the battery percentage is re-sent once after every start

## 1.9.1

- robot vacuum publishes on Homebridge 2.4.0; the map no longer gets stuck

## 1.9.0

- the robot as a robot vacuum in Apple Home (Matter)

## 1.8.2

- map camera - a patch seen through a window is left out too; carpets are remembered

## 1.8.1

- map camera - leave out floor beyond a virtual wall; no "0 m²"

## 1.8.0

- map camera - the robot's live map as a camera in Apple Home

## 1.7.6

- read the map while the Roborock app is open, ask more often, ignore a robot that stands still

## 1.7.5

- a fan showing an outside clean shows the robot's real suction

## 1.7.4

- keep asking for the map for a few minutes

## 1.7.3

- log every step of recognising an outside clean, retry sending the robot to the dock

## 1.7.2

- ask for the live map under an endpoint of our own, say why when no map comes

## 1.7.1

- notice cleans started outside Apple Home within seconds

## 1.7.0

- show cleans started outside Apple Home, Hebrew settings page

