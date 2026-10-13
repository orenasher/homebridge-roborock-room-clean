# Changelog

Notable changes per version. Older versions (before 1.7.0) are in the git history.

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

