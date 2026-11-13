# TickAssist

TickAssist is a local ticket-handling tool for Planmeca support: a note
generator with connections to CXone MAX, Dynamics 365 and Google Sheets.
It runs on your own PC as a small web page at
`http://localhost:8765/`; nothing is installed system-wide and no
administrator rights are needed. The Python it runs on comes with it.

## Starting and stopping

Start TickAssist from the Start menu or the desktop shortcut (or `run.bat` in
the program folder). Your browser opens on the page. Starting it while it is
already running just opens another tab on the running copy. To stop it, close
its console window (or press `Ctrl+C` in it).

The page is only reachable from this PC: TickAssist listens on localhost only.

## The rotation toggle

Top right, on every page: **First Impressions** or **Troubleshooting**. It is a
standing setting, not a per-note field — every note you save is stamped with it,
and it stays put across saves, Clear, and restarts until you switch it back, so
a whole shift gets tagged without touching it. On the First Impressions
rotation the whole topbar takes a rose tint, so which rotation you are logging
is answerable from any page at a glance.

Opening a saved ticket shows the rotation that ticket was taken on, and a second
copy of the toggle appears in the **Case Entry** header, right-aligned and
labelled *This ticket* — the rotation belongs with the ticket you are editing,
not with the app chrome. Flipping either copy retags just that ticket; the
rotation your next blank form starts from only moves when you flip the topbar
one with no ticket open. The Case Entry copy disappears when the edit session
ends.

The rotation is stored with the ticket and shown in the note preview, but it is
**stripped from the D365 copy** — it is internal bookkeeping, not case content
(the same treatment TITLE and DATE already get).

## The sections

- **Note Generator** — the original form + live D365 preview. The **System
  Environment** block folds away (click its heading) to keep the form on one
  screen; collapsing only hides it — every field keeps its value, still saves
  and still restores — and the heading shows a summary of what is filled in.
  The choice is remembered, and the section springs open by itself if an
  import or an opened ticket puts something in it. Auto-formats the
  case title, builds the copy-ready service note, runs **AI Polish**, and
  the Save button stores the ticket. Typing a phone number that has called
  before raises a **repeat-caller line** across the width beneath Contact Type
  and Phone Number — who they are, what they last called about, how many
  tickets in total and when the most recent was.
  It matches on digits, so any formatting finds it; it is a
  line of text rather than a dialog, so it cannot interrupt typing with someone
  on the line; it can be dismissed, and stays dismissed for that number until
  you enter a different one or clear the form; and the note you are editing is
  never counted as its own previous call.
  `Ctrl+S` saves, `Ctrl+Enter` copies
  the note (with its photos, same as **Copy Note**), and `Ctrl+P` prints just
  the note. An unsaved draft survives
  browser restarts and is restored automatically. **New D365 Case** opens a
  fresh case form in Dynamics with the title and description prefilled (uses
  your existing browser sign-in — no API key) and seeds the Windows clipboard
  history: Ctrl+V pastes the phone into the Customer lookup, and Win+V holds
  the contact name, serial number, and the full note for the Timeline
  (requires Windows clipboard history, Settings > System > Clipboard).
- **Settings** — one page, one scroll, no tabs. **Integrations** sits at the
  top as a row of tiles, one per connection to another system (Incoming calls
  from CXone MAX, Dynamics 365, Google Sheet), each showing its live status.
  Clicking a tile slides that integration's setup in as a drawer from the right,
  over the page, so nothing on the page moves and the rest of Settings keeps
  its layout: Appearance, AI Polish, the three managed lists
  and macros. A drawer saves only its own fields (**Save**, or `Ctrl+S` while
  it is open), and closing one with unsaved changes asks before discarding
  them. **Features** (top right of the page, see below) opens the same way.
  The sidebar's **Connections** list, below the nav, shows the integrations
  that are set up on this PC with a status dot - green live, amber needs a
  look - from every page, and a click opens that integration's drawer without
  leaving the page you are on. Nothing is listed there until something is set
  up. If D365 says your sign-in has lapsed while you are creating a case,
  **Sign in again** under the error opens the D365 drawer over the note.
- **Transfer call** (button above the note preview) sends the active call to a
  troubleshooting queue: it uses the Contact Name and Case ID fields, asks you
  to confirm, and posts to the address under Transfer setup (the old Call
  Triage page's signal.php). The call's ID is read from the address bar of the
  CXone call page (transfer_pop2.html?contactId=...) by the window reader, or
  arrives by screen pop: `/call?phone={ANI}&contactId={CONTACTID}`.
  AI Polish never drops detail: if the rewrite loses steps, numbers or error codes
  it is retried once, then your own text is kept; "Undo Polish" restores the
  fields from before the last polish.
  Settings has two tabs: General, and Lists & Macros (dealers, device types,
  Reco units, required-field rules, shorthand macros). Required fields: rules
  such as "Device Type is hardware -> Serial Number, OS Version, Firmware" block
  Save until filled (Shift+Click on Save skips, as for the Case ID).
  Sheet cross-check: with a sheet row found for the Imaging Package, system
  environment values that differ from that row get a red outline and a line
  under the package fields ("Use sheet values" copies the sheet's in).
  First Impressions works step by step: Caller, System Environment, Diagnostics,
  Case Details, Resolution. A step folds into a summary when you leave it with
  its required fields filled (Required Fields rules, per call type), the next
  opens, and later steps stay locked until then ("Open all sections" or
  Shift+click a locked step lifts that). Troubleshooting shows everything. The OS is a
  set of check boxes (several systems per call), and every System Environment
  field is a typable dropdown fed by saved tickets (Settings > Lists & Macros).
  Also: theme (Auto follows the Windows light/dark setting; dark,
  light, high-contrast, and LCARS can be pinned — the topbar button
  quick-toggles light/dark; LCARS is the Star Trek console look, whose elbow
  and rail turn lavender on the First Impressions rotation, and a scanner
  highlight sweeps the top strip, speeding up with a scan band over the note
  and pulsing fields while AI Polish is working — all off if Windows is set
  to reduce motion). On LCARS an incoming call also opens a transmission
  card (the caller's name, class, dealer, last device, last issue and status
  from earlier tickets, or "no prior record"), and yellow / red alert effects run
  when conditions you set in Settings > Alert Conditions are met (by default:
  handle time reaching 10 / 15 minutes, and safety words such as smoke or
  fire in the note), the AI Polish provider, model, and API key, plus the managed
  lists (dealers, device types, Reco units) and shorthand macros. List entries
  typed directly into ticket fields are auto-registered on save.

## Incoming calls (CXone MAX)

When a call comes in on CXone MAX (RingCentral Contact Center), TickAssist
reads the caller's number and puts it in **Phone Number**, which also brings up
the repeat-caller line. It only fills an **empty** field with no saved ticket
open. If you are still writing the last note, the number is offered on a line
under the field (**Use this number**), and it fills in by itself when that
note is saved or cleared, as long as that happens within 10 minutes.

It also sets **Contact Type** from the skill MAX shows with the call, so
`FI-Dealer Support` comes in as **Dealer**. That is set by **Caller type
rules** in Settings, one per line as `text in MAX = Contact Type`, with the top
rule winning:

```
Dealer = Dealer
IT = IT
Sales = Sales
Military = Military
End User = End User
```

A rule matches whole words (`FI-Dealer` contains the word `Dealer`), and a
keyword written in capitals, like `IT`, only matches capitals. Only text that
appears with the call is used, and text naming a different phone number is
skipped: MAX redraws rows of its call history as a new call arrives, and one
of those (`3174305321FI - Dealer Support08:01`) once typed an FI - IT Support
call as Dealer. The caller's own row is read first, then text naming no number
at all; numbers on the never-use list don't count as another caller. The same
goes for case numbers. If no rule matches, Contact Type is left alone, and the status
line in Settings shows the text that came with the call so you can write a
rule for it. The Contact Type is only set together with a number TickAssist
filled itself, never on a number you typed.

**Case number.** If a case number shows up in MAX with the call - such as
**Inbound Case Reference: CAS0490097** in the Call Triage & Transfer panel -
TickAssist puts it in **Case ID**. That panel can load when the call is
answered rather than when it rings, so a case number appearing up to two
minutes after the call still counts. It only fills a blank Case ID (never
replaces one already there, and tells you if MAX shows a different one), only
for a number TickAssist filled itself, and skips it if two different case
numbers appear at once. The screen-pop route takes it as `&case=CAS0490097`
too.

**Known callers.** When a number with an earlier ticket lands in Phone
Number - from MAX, or typed by hand - TickAssist fills **Contact Name** and
**Contact Type** from that caller's most recent ticket that has a name, and
for a dealer **Dealer Company** too, so 828-430-1927 comes in as Keith,
Dealer, Henry Schein. It only fills empty fields: Contact Type counts as empty
while it still says End User and you have not picked it yourself on this note.
A typed number fills once all 10 digits are in, so a half-typed one cannot
match a stranger, and if you then change the number, whatever the old one
filled goes back out (unless you have edited it since). A skill MAX shows
with the call still decides Contact Type; if it says the caller is not a
dealer, the copied dealer is taken back out. Nothing is filled while a saved
ticket is open. If the same number has been used by different people (a
dealer's main line, say), the toast names the others so you can correct it.

How it reads MAX: it uses Windows UI Automation, the accessibility interface
screen readers use, through a hidden PowerShell helper. Nothing to install and
no admin rights. Every ~1 s it looks at:

- windows whose **title starts with** one of the keywords (default `MAX`,
  `niceincontact`, `CXone`, `Mpower`), and
- Windows notifications whose text contains one, which covers MAX's
  "New Contact" desktop notification.

When it first sees a window, it records the numbers already showing (history,
your own line) and ignores them. Only a number that appears after that counts
as a caller. If several new numbers appear at once, nothing is filled and
Settings shows which ones it skipped.

Setup and troubleshooting (Settings > Integrations > Incoming calls, or the
**CXone MAX** row under Connections):

- Run MAX in its **own window** (it pops out of CXone that way). If MAX is
  just a tab, its title only shows while that tab is active.
- In MAX, Settings > Visual, turn on **New Contact** notifications (Chrome
  or Firefox; MAX does not offer them in Edge).
- The status line shows what it is reading. If nothing matches, it lists
  your open window titles, so you can copy MAX's real title start into
  **Window keywords**.
- Add your own team lines (anything MAX shows that is not the caller) to
  **Never use these numbers**.
- If it reports that PowerShell is blocked (some locked-down PCs run it in
  Constrained Language Mode), use the screen pop below instead.

**Screen pop (more reliable, needs a CXone admin):** a Studio `POPURL` /
`RUNAPP` action pointed at `http://localhost:8765/call?phone={ANI}` sends the
caller's number straight to TickAssist, without reading the screen. Adding
`&skill=` with the skill-name variable sets Contact Type through the same rules.

## Photos

Under the Note Preview is a **Photos** area. Paste a screenshot anywhere on
the Note Generator (Ctrl+V), drop image files on it, or use **Add Photos**.
Photos are kept with the ticket: an unsaved form's photos are saved with it,
reopening a ticket brings them back, Clear discards unsaved ones, and deleting
a ticket deletes its photos.

Large photos are scaled to 2000 px on the long side as they come in (small
ones and screenshots are kept as they are), which keeps them small and
each file well under D365's default 5 MB attachment limit. iPhone HEIC files
can't be opened by the browser; share them as JPEG.

Getting them into D365 without an integration:

- **Copy** puts the image on the clipboard; Ctrl+V pastes it into a D365
  timeline note's text.
- **Save** downloads it as `CAS0485494-1.jpg` for the note's attachment
  button. Dragging a photo to the desktop or a folder saves it the same way.
- **Copy All** and **Save All** do every photo at once - after Copy All, Win+V
  lists them. **New D365 Case** also loads them into clipboard history,
  below the phone, contact, serial and note.


**Photos paste with the note.** When the ticket has photos, **Copy** puts the
note and its photos on the clipboard together, so one Ctrl+V in the D365 note
brings the text with the pictures below it (D365's rich-text notes keep pasted
images with the note). Large photos are scaled to 1280 px for the paste; the
stored originals are unchanged. **New D365 Case** does the same for the note
it loads into Win+V. Pasting somewhere that only takes text gets just the
text. If your D365 notes are plain text (no formatting toolbar), the images
won't come across - use **Copy All** or **Save All** as before.

## Dynamics 365

TickAssist can create cases and add notes in D365 itself, signed in as you
(Settings > Integrations > **Dynamics 365**). Signed out, the buttons work as before: **New
D365 Case** opens a prefilled form and the note goes via the clipboard.

**One-time setup (IT).** In Microsoft Entra ID > App registrations, register
an app (single tenant), then:

1. **Authentication** > Add a platform > **Mobile and desktop applications**,
   redirect URI `http://localhost/d365/callback`.
2. Same page: **Allow public client flows** = Yes.
3. **API permissions** > Add > Dynamics CRM > Delegated > `user_impersonation`,
   with admin consent if users can't consent themselves.

No client secret is used. Enter the **Directory (tenant) ID** and
**Application (client) ID** from the app's Overview page, press **Sign in**,
and finish the Microsoft sign-in in the tab that opens. **Test** confirms the
connection and loads your org's Case Type and Origin choices, and lists any
other fields your case form requires; put those in **Other case fields** as
JSON (for example `{"prioritycode": 2}`, or
`{"new_product@odata.bind": "/new_products(<id>)"}` for a lookup).

**New D365 Case** (signed in) opens a dialog with the title, the description,
and the customer: it searches D365 contacts and accounts by the phone number
(any format) and preselects a single match, or you search by name or account
number. **Create Case** creates it, puts the case number in **Case ID**, adds
the note to the timeline, attaches the photos (one note each, since a D365
note holds one file), and opens the case in a new tab. By default the customer
is the contact's account with the contact as Primary Contact; Settings can
make it the contact instead.

**Send to D365** adds the note (and any photos not sent yet) to the case in
**Case ID**, after showing which case that is.

The sign-in is kept on this PC (`d365_refresh_token`, never shown
in the page); **Sign out** removes it. Changing the URL, tenant or client ID
also signs out. TickAssist can only do what your own D365 role allows.

## Google Sheet lookup

Type an **Imaging Package** number in the Note Generator and TickAssist looks it
up in a Google Sheet and fills the other fields from that row (OS, Romexis,
DIDAPI, firmware, Reco details, and so on). It only fills **empty** fields
unless Settings says otherwise, so nothing you typed is overwritten. A match
fills in quietly while you type; "isn't in the sheet" is only reported once you
leave the field.

Setup (Settings > Integrations > Google Sheet):

1. Share the sheet as **Anyone with the link can view** (or File > Share >
   Publish to web). TickAssist only reads it; nothing is written to Google.
2. Paste the sheet's link. A link to a particular tab keeps that tab (`gid`).
3. Set the **key column** (default `Imaging Package`).
4. Columns whose header already reads like a field map by themselves (`OS`,
   `Romexis Ver`, `DIDAPI`, `Device Firmware`, `Reco Unit`, ...). For any
   other, add a line to **Column mapping**: `Sheet column = TickAssist field`.
5. Press **Test**: it shows the row count and how every column mapped.

**Several tables in one column.** If the same column also holds another block
lower down (e.g. a "Viso Package" heading with its own package numbers), the
lookup sees each block as a section. A number found in more than one section
fills from the section whose name matches the ticket's **Device Type** (a Device
Type containing "Viso" prefers the Viso block); otherwise from the first one.
The other matches show as "Use ..." buttons under the Imaging Package field.

The sheet is fetched by TickAssist itself (not the browser) and cached for a minute;
if Google can't be reached, the last copy is used. Needs internet. It is a
feature (**Google Sheet lookup**) that can be switched off like the others.

## Features

**Settings → Features** (the button at the top right of Settings) shows which add-ons this copy offers: incoming calls
from MAX, Contact Type from the MAX skill, known caller details, case number
from MAX, photos, the Dynamics 365 integration, Google Sheet lookup and AI Polish.
A feature that is off is hidden on the page and its server routes are refused
(with D365 off, **New D365 Case** opens the browser form as it did before the
integration).

Every PC starts from the office defaults in `app\owner.json`, which ships
with the office build. Switching features on or off in Settings → Features
and pressing **Save Features** sets this PC differently; **Use office
defaults** returns it to them. The page reloads so every feature starts up
properly. If it says TickAssist was updated while it was running, close the
TickAssist window and start it again first.

## Shorthand macros

Define a trigger like `\rem` on the Settings page, then type it in any
generator field followed by space / Enter / Tab to expand it — multi-line
expansions included. `Ctrl+Z` undoes an expansion.

## AI Polish

The API key is stored locally on this PC and used **server-side**,
so it never leaves the machine except toward the provider. Two providers are
supported:

- **Google Gemini** (default) — model e.g. `gemini-2.5-flash`
- **Anthropic Claude** — model e.g. `claude-haiku-4-5-20251001`

Set the provider, model, and key on the Settings page. AI Polish needs internet
access to reach the provider; everything else works fully offline.

## Browser autofill

TickAssist turns off the browser's autofill on every field, and its secret
fields (such as the AI API key) are drawn as dots without being
password fields - so the browser never mistakes the page for a login and
offers to save or fill one. Before 4.11 it could: the browser saved the AI
model name as a "username" for localhost and then filled it into **Part
Recommendation**. If that happened to you, delete the saved password for
`localhost` in the browser (Edge: Settings → Passwords; Chrome: Settings →
Autofill and passwords → Google Password Manager) - it also holds your API key.

## Where your data is, and backing it up

An installed TickAssist keeps its settings, lists and macros in
`%APPDATA%\TickAssist` (`settings.json`, `lists.json` and `macros.json`);
back that folder up. Saved tickets and their photos are kept while TickAssist
is running, for the repeat-caller line and known-caller details, and are gone
when it closes. A copy started straight from its folder, without installing,
keeps the same files in its own `data` folder.

## Installing and updating

**Installing on a PC** (no administrator rights needed): download
`Install-TickAssist.bat` from the
[latest release](https://github.com/Ankokomen/Tickassist-Public/releases/latest)
and double-click it. It needs no network and nothing else beside it. It
installs for the current Windows user into `%LOCALAPPDATA%\Programs\TickAssist`,
adds Start menu and desktop shortcuts and an entry in Settings > Apps, and
another program can start it with `%LOCALAPPDATA%\Programs\TickAssist\run.bat`.
Settings and lists live in `%APPDATA%\TickAssist`, so reinstalling, updating
or uninstalling never loses them (the uninstaller asks before deleting them).
Running the installer over an installed copy replaces the program and keeps
that folder. Scripted installs: `Install-TickAssist.bat -Quiet` (add
`-NoDesktopShortcut` to skip the desktop icons); `-Dir "<folder>"` puts a
self-contained copy in that folder instead, with no shortcuts, which keeps
its data in its own `data` folder.

**Updating a PC**: Settings > General > Updates. The update address is the
GitHub repository whose Releases TickAssist installs from (it starts out set);
TickAssist checks it whenever it opens and shows an *Update x.y available* button
in the top bar. One click downloads the update, checks it against the SHA-256
GitHub publishes for it, replaces the program files (never the data,
`app/owner.json` or the bundled Python), keeps the previous version in
`<data>/updates/backup`, restarts itself and reloads the page. If anything
fails halfway, the old files are put back. The office settings can carry the
address to every PC (`update_url`).

A copy from before 6.4 doesn't find these updates by itself: run
`Install-TickAssist.bat` on that PC once. Its settings, lists and macros stay.

## Several Google Sheets

Settings > Integrations > Google Sheets now takes a list of sheets. Each has its
own link, the TickAssist field it is looked up by (Imaging Package, Serial Number,
Device Type, Case ID, Phone, Dealer or Contact), the sheet column holding that
value, an optional column mapping and its own "replace filled fields" choice.
Typing a value in a lookup field reads every sheet keyed by it and fills the
mapped fields; a filled field can in turn trigger another sheet (a serial number
can fill the Imaging Package, which then fills the OS and Romexis from the package
sheet). Old single-sheet settings are carried over automatically.

