# Changelog

[Русская версия](CHANGELOG.ru.md)

## Unreleased

### Connecting
- On a PC, a radio whose ESP32 has USB of its own (a Xiao, for one) keeps working after the app lets go of its cable. Since 0.4.0 the app raised two lines on the port, DTR and RTS, and when the port closed such a board took them for a flashing tool's and restarted into its loader: every later connection ended with "The radio did not answer in time", and the radio was off the mesh until it was reset. Now only DTR is raised, and nothing on a board behind a USB-to-UART chip (CP210x, CH340, FTDI). A radio already stuck this way needs its reset button pressed once, or its power off and on.
- A PC that uses the radio through an Android phone (Share with a computer) finds the phone's sharing again after the phone's Bluetooth has restarted. The phone then keeps the sharing at another place than Windows remembers, and every connection ended with "subscribe: … ATT 0x01" until the phone was removed from Windows and paired again. Now the app asks the phone where the sharing is and connects there.

### Chats
- The radio's name and charge stand at the top of Chats, beside the title, so which radio the app is on shows without a trip to Settings. A long name takes the room the title leaves and is cut only past that; the charge is never cut. At 20% and below the charge turns yellow with a warning mark. While the radio is not connected the name dims behind a red dot. A tap opens Settings, where the radio's card is. On a PC the name is at the top of Mesh too, and the radio's button at the bottom of the column of sections is gone: the name says the same, and Settings carries the red dot while the radio is not connected.

### Mesh and the map
- On an iPhone a running coverage survey shows on the locked screen: "Survey running · 25 points", its time counting up, and under it who heard the last point or why none is being made, as in Android's notice. On an iPhone with a Dynamic Island the count stands there while another app is open, with a green dot when the last point was answered. It goes when the survey stops. It needs iOS 16.2, and can be turned off in the phone's Settings › Ommesh › Live Activities.
- On Android a running coverage survey shows in a notice of its own, on the locked screen too: "Survey running · 25 points", its time counting up, and under it who heard the last point ("3 hear you · best PKIO +12 dB") or why none is being made: nobody answered, standing still, waiting for GPS, radio not connected. It makes no sound, and the plain "Connected to …" is back when the survey stops. Its kind, "Coverage survey", can be set apart in the phone's notification settings.
- A coverage survey goes on with the phone locked or the app out of sight. On a phone connected to its radio over Bluetooth, "Survey on the move" used to stand still from the moment the screen went off, and said so when you came back. Now the phone keeps asking every half minute while you move, and the points are there when you open the app again; the survey's card says "goes on with the phone locked". Meanwhile Android says "Coverage survey running" in its notice about the radio, and an iPhone shows its own location sign in the status bar. A survey with a Wi-Fi radio, in a browser or on a computer still runs only while the app is open.
- A survey's export sheet starts with the coverage map: one large Send to MeshCoreTel button, with the files under it. The map used to be under the four files, below the edge of a phone's sheet. Once a survey is sent, the button's place says so, with when it went and how many points, and Send again beside it. The words asked before every send are the same.
- Past surveys show which of them are on the coverage map: a green cloud with a tick at the end of the row, and the count at the top, such as "5 surveys · 2 on the map". A survey's summary says "on the map" beside its time. Surveys sent before this build are marked too.
- While a coverage survey runs, a large number stands at the top of the map: how many repeaters answered at the last point, on a disc in the point's colour, to be read at a glance from behind the wheel. The ring round it fills until the next ask: by the half minute, and once the phone stands still, by the metres left to go, written under it ("24 m to go"). A tap on the number opens who answered. The number stays on the map with the survey's card put away, and the strip over the other screens carries it too. The small ring in the card is gone.
- A survey says aloud what each ask brought: two notes up when a repeater answered, two notes down when nobody did. The speaker button in the survey's card turns the sound off, and the choice is kept. A phone plays it the way it plays the message signal, so its silent mode quiets this too.
- The map no longer closes in and out with every point of a survey. It keeps in view the phone and every repeater that has answered in this survey: it moves out when a farther one answers and never back in by itself. Move or scale the map by hand and the scale stays yours: the map then only goes along with the phone while the phone is on screen, and Where am I brings the whole view back. It used to return to its own view 20 seconds after a finger moved it.
- While a survey runs, the repeaters that answered at the last point have their names in bold on the map and the other names step back, and a scale in the corner says how far the map reaches.
- A repeater's or a sensor's page has Forget the route under its Route row, so a route that has stopped working is dropped with one tap. It used to take four: the route's sheet, ⋯, Forget the route now, and back. The row is there while the radio holds a route to the node. The note that follows has Undo for eight seconds, which writes the route back; nothing goes on the air either way. Forget the route now in the route's menu has the same Undo.

### Settings
- Advanced no longer has Tuning: extra acknowledgements, the receive delay base and the airtime factor. They took numbers only the firmware's makers know how to pick, and a wrong one could slow the mesh down for everyone. A radio keeps what was set there before.
- The log no longer lists every packet the radio hears as a line of hex. One came every few seconds, and within minutes they pushed out the events worth reading: connecting, errors, new nodes, routes. The packets are in On the air, with who sent them, what they are and how they came.
- Settings › About has People: everyone who has written code for Ommesh or told of a problem or an idea on GitHub, with their pictures, and a thank-you under them. The list comes with the app and needs no network. About also has Report a problem or an idea, which opens a new issue on GitHub in the browser.

### Tablets
- On a tablet the app turns with the screen. Held sideways, it is laid out as on a computer: the sections down the side, the list, and the chat or the map beside it. An Android tablet used to keep the app upright between two bars, and an iPad showed the iPhone app in a phone-sized window. Held upright, a tablet shows the phone's layout. A phone stays upright as before.
- On a tablet held sideways, pull the conversation to the left to see each message's signal and hops, as on a phone.

### Fixes
- On an iPhone or iPad with iOS 15 or 16 before 16.4, the app opens again. Since 0.4.0 it showed only a grey screen there.

## 0.5.0 — 2026-09-30

### Updates
- An Android phone on a Dev build from GitHub hears of newer ones. A strip over the chats says "A newer build is out" with its version and Download, which opens the newest APK in the phone's browser. The cross hides the strip for a day. About has the newest build too. The app checks when it opens and when it comes back on screen, at most every six hours. Builds from Google Play keep updating through Play.
- On a PC, Download update reads the feed again first and downloads the newest build. An update found hours before used to fail with "404 Not Found" once newer Dev builds had replaced it, until the app was restarted. An update already found is looked for again every six hours too, so the version on show stays the newest.

### Connecting
- With Bluetooth off, Android puts up its own prompt to turn it on: at launch, when the connect screen starts its search, and when a radio is picked. Turned down, the search and the line at the top say "Bluetooth is off" instead of finding nothing or trying for a long time; Try now asks again, and the radio is back a moment after Bluetooth is turned on. An iPhone says "Bluetooth is off" too.
- A PC that uses the radio through a phone (Share with a computer) gets the link back by itself when the phone takes the sharing down and puts it back. Windows could hang while closing the phone's old link, and the app then showed "Reconnecting" for hours, until it was restarted. Now it leaves that call behind after 15 seconds and connects again.

### Chats
- A channel message no repeater was heard passing on stays red and has two buttons along its bottom edge: Send again sends it once more, and Keep trying sends it up to five times over about 20 minutes, stopping as soon as a repeater is heard passing it on. Keep trying used to be only in the menu of a long press.
- A message stands in its chat in the order it came in, not by the time the sender's radio put on it. A radio that has lost its clock stamps its messages with a date years back, and such a message used to go up into the history, while the chat list showed it as the latest. Now it comes in at the bottom with the time it arrived, and How it travelled has its sender's date and time and says their clock is off. Messages the radio kept while the app was away still show when they were sent.
- A web address in a message opens in the browser with a tap. It counts as one when it starts with http://, https:// or www.; the full stop or bracket of the sentence around it is left out. A long press on it still opens the message's menu.

### Mesh and the map
- The ≋ button on the map no longer sends anything when tapped. It opens Who hears me with the answers to the last ask and how long ago that was; the packet goes out only from Ask now. Held until the red ring round it closes, the button starts a coverage survey at once, with "Survey started" and Undo, which drops it whole. The sheet tells of the hold until a survey has been started that way once.
- A coverage survey running is never out of sight. Put away with the arrow on its card, with Back or with ≋, it goes on under a strip at the top of every screen, "Survey running · 02:14 · 5 points", and the Mesh tab has a red dot while another tab is open. A tap on the strip goes back to the survey. Who hears me shows it on top as well; it asks by itself every half minute, so Ask now waits while it runs.
- The survey sheets step back one at a time: a point or the files to the survey, a survey to Past surveys, the list to Who hears me; the cross closes them all. A survey stopped goes to its summary, and Back from there to the list it was kept in. A survey stopped before its first point says it was not kept, and why when the GPS or the radio was the reason.
- A repeater's neighbours on the map can be narrowed down. The funnel at the top of their sheet opens two sliders, Heard no worse than (in dB) and Distance from the repeater (from and up to), and a switch that hides those not heard for a day. Dots over each slider show where the neighbours are on it. The lines, the list and the counts change as a slider moves, and when you let go of the distance the map comes to the neighbours left, with a dashed ring at the distance picked. With the sliders put away, what the filter keeps stays under the sheet's title, and the cross shows them all again. The filter goes along to a neighbour's own neighbours and is gone once the map of neighbours is closed.
- The end of the Mesh search field says how many nodes there are, such as "68 nodes". While a kind picked in the filter or a search hides some, it says how many are shown out of all, such as "15 of 68", in the accent colour. The map shows the same nodes as the list.
- A power monitor such as an INA219 draws its day on the Voltage and Current tiles, the way the battery draws its week: a line through what the node answered in the last 24 hours, with its lowest and highest under it, such as "144 readings in 24 h: 61 to 457 mA". Touch or point at the line for the reading at that time. The line fills as the readings are asked for; this radio's Readings page asks every half minute while it is open.
- With Group close nodes off, the map draws nodes at half their size while a whole town is on the screen and grows them back as you zoom in, so the repeaters of a city no longer pile on one another and each one's state can be told apart. The node you picked keeps its full size.
- A repeater's picture is a tower on two legs with waves around its top, in place of a mast that was hard to make out. It stays apart from the mark on buttons that transmit, which is a mast on one pole.
- A repeater's Neighbours page fits a phone: one row per neighbour, with its name, key and when it was heard on the left and its SNR over a bar on the right, in place of a table whose last column was cut off. What the bar spans is in the note under the list, and on a phone the order buttons have a line of their own.
- On a node's Access page, a phone puts each client's role and Remove under its name, and the role is no longer cut short.
- In the Neighbours and Who hears me sheets, when a node was heard and how far away it is wrap under its name instead of ending in "…".
- On a repeater's Neighbours page an admin can have the repeater look for its neighbours. Find neighbours has it call the repeaters it hears on the air, waits the few seconds they take to answer and reads the list again, newest first. A line above the list counts down while they answer, then says how many answered and how many of them are new; the new ones are lit for a moment and marked "new".
- A repeater's or a room's Packets and signal gives received, sent and dropped duplicates a row each: the total, and under it how many went by flood and how many direct. Receive errors have a row of their own with their share of everything the node heard in brackets, such as "950 (24.2%)". The SNR is written the way numbers are in the app's language.
- A sign-in, a status, neighbours, settings and console commands go to a node once per tap, and the app sends it nothing on its own. Before, a request that heard nothing went up to five times and then to the whole mesh; after that the app signed in to the node through the whole mesh to renew its way back and sent the request again, read a silent `set` back with `get`, and asked a repeater for its firmware and owner after each sign-in. One tap could put a dozen packets on the air, several of them sent on by every repeater, and on 28 September that filled the mesh. Now a command that got no answer has Send again under it, and Renew the way back when it is the last one; a sign-in that heard nothing offers the same, and Ask for firmware and owner is in the profile's menu.
- A node's Clock row shows how far its clock is off, and an admin can check it again with a tap. The row used to say "in sync" from the sign-in, however long ago that was. A tap asks the node the time once, and the row says "5 min ahead", "3 s behind" or "on time" and when it was checked; any other console command checks the clock too. A clock more than 30 s ahead offers Reset its clock and reboot straight away, and the confirmation says how much longer radios that heard its adverts will skip its new ones. After Set its clock from this radio the row shows what the node answered rather than taking it on trust.

### Settings
- On a phone the log puts each entry's time and kind above its text, so the text has the whole width.
- The privacy policy is a row under About, with the version.

### Notifications and the background
- Messages that arrive all at once, such as the ones the radio kept while the app was away, ring once rather than once each: the first notice sounds, and the rest bring its count up to date quietly. Messages written seconds apart still ring each.
- On a phone a notice is its words alone, under the app's icon. The picture of who wrote is gone: a watch showed it in place of the message, and on Android it stood where the app's icon should be.

### Fixes
- A phone connects to a radio over Wi-Fi by its address. Before, it waited 45 seconds and said the radio did not answer, whatever the address.
- A profile's buttons no longer run into one another when a word is long; a long word breaks instead.
- A value that does not fit its row, such as a route, the firmware or a notification setting, goes on to a second line instead of ending in "…". A line never starts with "·".
- An error message is shown whole, up to four lines, instead of being cut after two.
- A time such as "2 h 32 min" no longer breaks between a number and its unit.
- With large text, the tiles under On air stay inside the screen and no longer push it sideways.
- On a desktop, the side rail is wide enough for its labels in Russian.
- Set its clock from this radio no longer says "Clock set" when the node kept its time. A node's clock only goes forward, so when it runs ahead the app says so, and the row becomes Reset its clock and reboot: the node restarts with its clock at 15 May 2024, and then its clock can be set from the radio. Setting the radio's own clock says too when that clock runs ahead.

## 0.4.0 — 2026-09-28

### The name
- The app is called Ommesh everywhere: on the desktop and in a browser, as on a phone. On Windows the update takes Meshnet's place: the same folder, the Start menu and desktop shortcuts renamed, one entry in Installed apps, and autostart, history and settings kept.

### Settings
- The Radio tab is called Settings, with a gear. The paths to its pages and the command palette say Settings too.
- Settings › Chat history saves the radio's chats to a file and brings them back from one. "Save to a file" writes its channels, contacts and every message with its time, signal and delivery; a phone hands the file to Share, a desktop downloads it. "Bring in from a file" takes such a file, or the database the official MeshCore app exports, and first shows how many messages, chats and contacts it brings, over which days, and what it leaves out. A channel goes to the slot on the radio with the same secret; one the radio does not have is left out and named. Contacts the radio does not hold go to Removed. A message already here is not added twice, so the same file brought in again adds nothing, and messages brought in are not unread. A file of another radio is refused. The file holds private messages and channel keys, but no node passwords. Its format is open and described in the project's docs, so other programs can write and read it.

### Chats
- A message of one to three emoji and nothing else is drawn large, without a bubble, with its time on a small patch under it.
- The Find field over the chats finds messages in every chat as well as chats by name. From two letters, the messages that hold the word come in their own group, the newest first, each with its chat, who wrote it and the words around it, the word marked. A tap opens the chat at that message, which flashes; Back returns to the results. Case and ё do not matter, and Russian sent with Latin lookalike letters is found by its Russian words.
- A chat's magnifier, or Ctrl+F on a desktop, finds within that chat. Every match is marked, the one in sight ringed, and the arrows under the list, or Enter and Shift+Enter, step to earlier and later ones. Ctrl+F pressed again goes to the Find field over the chats.
- Every search field, over the chats, in a chat, over the Mesh list and among the people for a new chat, has a cross at its end once something is typed. It empties the field and leaves the keyboard up.

### Connecting
- The connect screen puts one radio at the top: the one being connected to, or else the last one. Its card shows the name, the way and the address, Connect, and the switch to connect at launch. While the radio connects, the card says which try it is and which step it has reached (the link, the radio answering, the saved chats), and Cancel stops it, the connect at launch included. A radio that asks for a PIN gets the field in the card. A failure is one line with what to check and Try again; the rest of the message is behind Details.
- The radio card shows how well the phone hears the radio over Bluetooth, with the same four bars as the list, drawn empty when the search has gone two seconds without hearing it. A tap on the bars gives the figure in dBm, or says the radio may be off, too far away, or connected to another phone, since a radio stops advertising while one is. On a phone the bars follow the radio as it moves, updated once a second.
- The search under the tabs runs by itself and pauses while a radio connects, so only one thing moves on the screen. Radios come first, the strongest on top. Phones sharing a radio, and ports that are not a radio's cable, fold under "N more". Names lose "MeshCore-", and the second line is the address.
- Updates and the privacy policy are a small line at the bottom.
- The app opens on the last radio's chats, read from this device, with "Reconnecting" above them while the link comes up, rather than on the connect screen. On a phone they are on screen about half a second after the app starts. A radio that stays away is tried again for as long as it takes, as after a drop.
- The chats open as soon as the radio has answered. Its contacts and channels, and the messages it kept, are read after, with the chats on screen. On a phone that used to hold the connect screen up for about 20 seconds; now it takes about a second.
- On Android, a page the system lets go for memory, or whose renderer it ends, takes over the link the app kept to the radio when it comes back, in the background as well. The chats are back in about a second. The page used to connect afresh, and one made in the background waited for the app to be opened first.
- On Android, the link runs at its fastest while the app talks to the radio and eases off 15 seconds after: a command and its answer take 60 ms rather than 270, and the channels read at connect take 2.6 s rather than 8.
- On Android, a dropped link comes back as soon as the phone finds the radio again, rather than when the next try is due.

### Mesh and the map
- The map turns: twist it with two fingers, or drag with the right mouse button. Names and pins stay upright, and a compass button, shown while the map is turned, brings north back up. The map is now drawn by MapLibre on the GPU, so a pan, a pinch and a turn keep the screen's full rate (120 frames a second on a realme phone with 80 nodes); a dark theme's tiles are darkened by the same GPU rather than tile by tile. Tiles are still OpenStreetMap's and still kept on the device for use without a network.
- On a phone the map's crosshair is "Where am I": it asks for the phone's location the first time, and draws the phone as a ring with a circle for how sure the fix is. When this radio is more than 50 m away, a "Put the radio here" button with the distance hangs under the ring; Undo puts it back. Refused, the crosshair goes to the radio as before and says where to allow it.
- Settings › Name and position has "Follow the phone", kept for each radio. While it is on and the app is open, the radio gets the phone's position when the phone has moved more than 50 m, at most once in 5 minutes and only from a fix good to 100 m, since each one is written to the radio's flash. The coordinates are then read-only. A radio with its own GPS turned on is not followed. "Use this device's position" now works on Android too, which asks for location only when one of these is pressed.
- On a phone, a node tapped in the list or on the map opens its profile at once, as on a desktop. The card in between, with only a Profile button for a repeater, is gone. Back returns to the map with the node ringed and its route drawn, and "On map" lowers the list so the map has the room.
- The Mesh list starts right under the search. What to show, the order, "Yours and favourites on top" and fetching every contact again sit behind the button beside the search, which carries a dot when something is changed; each change shows as a chip under the search, taken off by its cross. The list is one list by default. "Who hears me" is a button on the map.
- The password for signing in to a repeater, a room or a sensor, and a node's new admin password, have an eye at the end of the field that shows what was typed.
- A node's console is written in the same frame as a chat message, with the round send button, and an empty console has no text in it.
- Coverage survey: "Survey on the move" under "Who hears me" asks the same question every 30 seconds while the phone moves, at least 50 m from the last point and only on a GPS fix good to 50 m. Each ask is a point on the map: green, amber or red by the worse of the two ways at the best repeater that answered, hollow grey where nobody did. While it runs, lines go from the last point to the repeaters that answered there, the map keeps the phone, that point and those repeaters in view, the screen stays on, and a card over the map shows the time, the points, who hears the radio now and when the next ask goes, or why it waits: standing still, GPS, the radio away, the screen having been off. A tap on a point lists who answered there, with lines to them on the map.
- After Stop, the survey shows its time, distance, points and share answered, and the repeaters by how many points each answered at; a tap on one leaves only its points coloured. Export writes JSON that MeshCore Wardrive opens, GPX, KML or CSV, handed to Share on a phone and downloaded elsewhere. Surveys are kept with the radio's history under "Past surveys"; Delete has Undo. The radio's own position is left alone.
- A survey can be sent to the MeshCoreTel coverage map from the phone or desktop app, in the upload MeshCore Wardrive makes. Each time, the app first says what goes (the points with their places, times, repeaters and signal) and that it goes to another site, where everyone sees it and the app cannot take it back; the survey then shows when it was sent. Nothing leaves without that step.

### Readings
- Every node shows how it is doing in one block, Readings, the same for this radio, a person, a repeater, a room and a sensor: the battery first, then for a repeater or a room the Noise, On air and Running tiles, then the radio itself (Board, Position), then a set of tiles for each sensor channel (a power supply shows its power first, as voltage times current). One Refresh asks what the node answers. The repeater's Status and Telemetry blocks are gone.
- A repeater's or a room's Refresh asks its status; its board, position and sensors are one row of their own, "Board, position and sensors · Ask", with their own time once answered.
- The battery reads as a charge. A tap on it picks the cell for that node, Li-ion/LiPo or LiFePO4; until someone picks, the charge is counted as Li-ion and said with "≈". The app keeps a week of battery readings for every node, not only repeaters, from the answers it was asked for, draws them as a line, and says "going down" when the week's fall shows.
- Settings › Readings holds this radio's battery, noise, air time, uptime, board, position and sensors, read over the link as the page opens and every half minute while open. The Battery and Sensors rows are gone from Settings.
- Numbers are written the reader's way, 3,38 in Russian, and a position says how far and which way, with a link to the map.

### Desktop
- Each Windows installer also comes as an offline one, `…-offline-setup.exe`, for a machine with neither WebView2 nor the internet, such as Windows 10 LTSC or a fresh image. It carries WebView2's own installer, about 190 MB, and runs it only where WebView2 is missing. Updates keep downloading the small installer, and Windows 11 already has WebView2, so there the ordinary one needs no internet either.

### Fixes
- After Disconnect, connecting to another radio stays on the connect screen. It used to bring back the old radio's chats with "Reconnecting".
- On Windows, a Bluetooth connect that was given up can no longer close the next connection when it finishes late.
- A current flowing back, such as a battery charging through an INA sensor, reads as negative. The firmware's CayenneLPP writes voltage and current signed, and the app read them unsigned, so -16 mA showed as 65.52 A and the power as 228 W.
- On the desktop, a radio on USB whose board speaks through TinyUSB (the nRF52 ones: T-Echo, RAK) connects. The port opened with DTR off, and such a radio answers nothing until the computer raises it.
- A sensor's power reads as its voltage times its current when the channel carries both, so 3.38 V at 119 mA shows 402 mW rather than 0 mW. The firmware sends power in whole watts. A sensor's History does the same with its means, and with its lows and highs for the range.
- On an iPhone the chat rises smoothly with the keyboard again, however long the chat. The keyboard's height was animated on the whole page, so every frame restyled every message: in a chat of 2,000 messages each frame took about 57 ms, and the rise stuttered. In a chat, all under its header now rises by a transform that the phone animates itself, in step with the keyboard, while the header stays and the list slides under it. A message being answered still ends up in sight, gliding there with the rise. Elsewhere only the app's frame and the layers over it follow the keyboard.
- A chat draws its latest 60 messages when it opens, and a hundred more each time you scroll near the top, with what is on screen kept where it was. A search result or a match further up is drawn in with the ten messages above it. A chat of 2,000 messages opens in a seventh of the time it took.
- Signing in to a repeater, asking its status and its console commands keep going on a weak route. A request goes along the route up to five times before it is given up; on a two-hop route where one round trip in three gets through, that is an answer nine times in ten. A route set by hand is never dropped for a flood any more: one silent sign-in used to drop it, and every command after went into a flood that did not get there. A learned route that stays silent through all five is dropped and the request floods once. A console command that reads (`get`, `ver`, `neighbors`) goes each time with a new stamp; one that changes something goes with the same stamp, so the node carries it out once, and a `set` that heard nothing back is read back with `get` to say whether it took. The console line says which try it is and which one was answered, and the log says where each request went.
- A repeater answers along its own way back to this radio, which it learned once and keeps however stale it gets; then every command reaches it and every answer is lost, while a route check, which comes back the way you set, still passes. A request to a node that heard nothing along the route now renews that way back by itself and goes once more: a sign-in sent to the whole mesh, which makes the node forget its old way and learn a new one, while your route to it stays. It does so for a sign-in, the status, neighbours, settings and the console alike, at most once in 10 minutes for each node, and without asking when the node's password is kept; the console line says the way back is being renewed and that the answer came after it. When it cannot, the console says so under the command, with Renew the way back, and a sign-in that heard nothing offers the same. A route set by hand is put back when the radio takes the way an answer came as its route, and when the app finds the radio holding another as it connects.
- Swiping back from the left edge follows the finger smoothly. Each move restyled the whole screen underneath and painted it again with its dimming; now both screens and the dimming move as the phone's own layers, and the dimming fades out as the screen settles rather than vanishing at once. The tabs of the screen underneath come in with it rather than appearing once the swipe is over, and slide away with it when a chat opens.

## 0.3.0 — 2026-09-26

### Languages
- The app speaks Russian. It follows the system's language, or the one picked under Radio › Appearance › Language. Notifications, the desktop tray and Android's radio notice speak it too.
- A new language is a folder of JSON files, with no code to touch (`apps/web/src/i18n/README.md`).

### Notifications and the background
- Android keeps reading the radio, and announces its messages and new nodes, with the app closed.
- On iPhone, notices that arrive with the phone locked carry the message text.
- On Android, when the phone runs short of memory, the page is let go and the link to the radio is kept. Before, the whole app was ended.
- The app can draw its own notices: corner cards on the desktop with a reply field. Notices show who wrote, and ring with a signal you pick.

### Sharing the radio with a computer
- A phone connected to the radio can share it with a computer over Bluetooth, on iPhone and Android. Both use the radio at once, and each shows what the other sent.
- The desktop pairs with a phone sharing its radio without asking for a PIN.

### Chats
- A chat opens at its first unread message, under an "N new messages" band. A round button jumps to the latest.
- Sort the chat list by latest, name or unread, with channels optionally on top.
- In channels and rooms, each message shows its sender's avatar.
- A direct message goes again on its own until it is acknowledged ("Send tries", 5 by default).
- A message that did not get through can be deleted.
- On a phone's keyboard, return starts a new line and the send button sends. With a real keyboard Enter sends, and Ctrl+Enter starts a new line.
- "How it travelled" gives one line per relay.
- The note after an action is a card, with a countdown on Undo.

### Mesh and the map
- Sort the node list by heard, name, distance or relays, with yours and favourites on top.
- A repeater's neighbours are drawn on the map, coloured by signal.
- Hold or right-click on the map to put your radio at that spot, check line of sight or copy the coordinates. The position fields also take a pasted "lat, lon".
- A route is one sheet over the map. When a route breaks, the app finds a way round from what the radio has heard, and can keep looking from where the search stopped.
- A trace waits as long as its hops can take, rather than the radio's sixfold guess.
- The console suggests every command the firmware answers over the air.

### Radio
- A battery can be LiFePO4 as well as Li-ion/LiPo; its charge is read off a curve for each.
- Pull down on Radio to read everything from the radio again.
- Ten colour themes, picked from tiles.
- Sensor current is shown in mA, and power in mW.
- The 869.161 MHz preset is named OMS.

### Connection
- A dropped link is retried until the radio is back, with "Try now" in the offline bar.
- The offline bar offers to pair when the radio wants a bond. The desktop asks for the PIN whenever an unpaired radio fails to connect.
- On Android, a radio the phone has never met is paired from the app: the PIN prompt comes up by itself, and the app waits while it is typed. A PIN left untyped or wrong says so, and the app stops asking again on its own.

### Desktop
- Closing the window keeps the app in the tray, with a dot for what is unread.
- The window opens where it was left.
- Updates are checked through a SOCKS proxy too.
- A 32-bit Windows installer.

### Fixes
- A node's answer no longer ends in the zeros that pad it to a cipher block.
- A channel message sent again from another app is kept as the same message.
- What the phone sent while the computer was away shows as sent.
- On Android, connecting no longer hangs at "Connecting…" on a phone new to the radio, and a first connect gets through more often.
- On Android, the message field no longer slides under the on-screen buttons when the keyboard is put away, nor floats above the keyboard on Android 14 and older. The status bar and buttons take the app's theme.

## 0.2.0 — 2026-09-23

The first release on Google Play and the App Store.
