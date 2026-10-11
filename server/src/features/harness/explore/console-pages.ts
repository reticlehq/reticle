/**
 * Pages of the real console, read in full by a live persona drive (persona 21), trimmed. The
 * exploratory Harness's tests replay its live misses against these rather than against a tidy tree.
 */

/** Impact (/overview), signed in: the rail, the banner and the top of the page. */
export const CONSOLE_OVERVIEW = `- link "Skip to content" (ref=e68)
- complementary
  - link "Impact" (ref=e95)
    - img "Reticle" (ref=e96)
  - navigation "Main" (ref=e97)
    - link "Impact" (ref=e77)
      - text "Impact"
    - link "Chat" (ref=e98)
      - text "Chat"
    - link "Inbox" (ref=e99)
      - text "Inbox"
    - link "Issues" (ref=e100)
      - text "Issues"
    - link "Runs" (ref=e101)
      - text "Runs"
    - link "Flows" (ref=e102)
      - text "Flows"
  - region "Chats" (ref=e103)
    - paragraph [text="Your chats will be listed here."]
  - button "Account: Bea Final21, Bea-Labs F302964 · Pro" (ref=e104)
    - text "Bea Final21"
    - text "Bea-Labs F302964 · Pro"
- button "Resize sidebar" (ref=e105)
- banner
  - button "Hide sidebar (⌘B)" (ref=e106) [pressed]
  - button "Bea-Labs F302964" (ref=e107)
    - text "Bea-Labs F302964"
  - button "All projects" (ref=e108)
    - text "All projects"
  - button "Search, ⌘K" (ref=e109)
    - text "Search"
    - text "⌘K"
  - link "14 days left · 500 trial credits left" (ref=e73)
    - text "14 days left"
    - text "· 500 trial credits left"
  - generic "p21f-bea-302964@example.com" (ref=e110) [grid-cols:20px]
  - generic "p21f-ana-302964@example.com" (ref=e111) [grid-cols:20px]
  - generic "p21f-raj-302964@example.com" (ref=e112) [grid-cols:20px]
  - link "Invite" (ref=e113)
- main
  - heading "What Reticle did for your team" (ref=e91)
  - paragraph [text="Last 30 days"]
  - paragraph [text="Reticle tested the work of your team 1 time in the last 30 days and found nothin…"]
  - link "Runs that failed 0 of 1 run" (ref=e114)
    - text "Runs that failed"
    - text "0"
    - text "of 1 run"
  - link "Runs that passed 1 of 1 run" (ref=e115)
    - text "Runs that passed"
    - text "1"
    - text "of 1 run"
  - link "Runs that partly passed 0" (ref=e116)
    - text "Runs that partly passed"
    - text "0"
  - link "Runs not proved 0" (ref=e117)
    - text "Runs not proved"
    - text "0"
  - link "Issues found and fixed 0 An issue that a later check passes." (ref=e118)
    - text "Issues found and fixed"
    - text "0"`;

/** Flows (/flows): Memory is a link in the page's own "Flows" navigation, not in the rail. */
export const CONSOLE_FLOWS = `- link "Skip to content" (ref=e68)
- complementary
  - link "Impact" (ref=e95)
    - img "Reticle" (ref=e96)
  - navigation "Main" (ref=e97)
    - link "Impact" (ref=e77)
      - text "Impact"
    - link "Chat" (ref=e98)
      - text "Chat"
    - link "Inbox" (ref=e99)
      - text "Inbox"
    - link "Issues" (ref=e100)
      - text "Issues"
    - link "Runs" (ref=e101)
      - text "Runs"
    - link "Flows" (ref=e102) [focused]
      - text "Flows"
  - region "Chats" (ref=e103)
    - paragraph [text="Your chats will be listed here."]
  - button "Account: Bea Final21, Bea-Labs F302964 · Pro" (ref=e104)
    - text "Bea Final21"
    - text "Bea-Labs F302964 · Pro"
- button "Resize sidebar" (ref=e105)
- banner
  - button "Hide sidebar (⌘B)" (ref=e106) [pressed]
  - button "Bea-Labs F302964" (ref=e107)
    - text "Bea-Labs F302964"
  - button "All projects" (ref=e108)
    - text "All projects"
  - button "Search, ⌘K" (ref=e109)
    - text "Search"
    - text "⌘K"
  - link "14 days left · 500 trial credits left" (ref=e73)
    - text "14 days left"
    - text "· 500 trial credits left"
  - generic "p21f-bea-302964@example.com" (ref=e110) [grid-cols:20px]
  - generic "p21f-ana-302964@example.com" (ref=e111) [grid-cols:20px]
  - generic "p21f-raj-302964@example.com" (ref=e112) [grid-cols:20px]
  - link "Invite" (ref=e113)
- main
  - navigation "Flows" (ref=e144)
    - link "Flows" (ref=e148)
    - link "Plans" (ref=e149)
    - link "Memory" (ref=e150)
  - heading "Flows" (ref=e151)
  - paragraph [text="Saved paths through your app. Reticle can replay each flow."]
  - group "View" (ref=e152)
    - button "Map" (ref=e153)
    - button "List" (ref=e154) [pressed]
  - text "Flows"
  - text "1"
  - text "Pages they reach"
  - text "1"
  - text "Failing now"
  - text "0"
  - text "Not replayed yet"
  - text "1"
  - heading "Starts at /" (ref=e146)`;

/**
 * Impact with the workspace switcher open, as the live drive left it: the menu makes the rest of the
 * page inert, so a read sees the menu and nothing else.
 */
export const CONSOLE_SWITCHER_OPEN = [
  '- menu "Bea-Labs F302964" (ref=e300)',
  '  - menuitem "Bea-Labs F302964" (ref=e301)',
  '  - menuitem "New workspace" (ref=e302)',
  '- region "Notifications alt+T" (ref=e1)',
].join('\n');

/** Memory (/memory): the shared project's records. */
export const CONSOLE_MEMORY = [
  '- main',
  '  - navigation "Flows" (ref=e144)',
  '    - link "Flows" (ref=e148)',
  '    - link "Plans" (ref=e149)',
  '    - link "Memory" (ref=e150) [focused]',
  '  - heading "Memory" (ref=e160)',
  '  - heading "One record your team disagrees on" (ref=e161)',
  '  - button "Free shipping threshold 1 saved fact updated today" (ref=e162)',
  '- region "Notifications alt+T" (ref=e1)',
].join('\n');
