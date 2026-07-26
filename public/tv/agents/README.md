# Agent photos

Drop one image per agent in this folder, named after the display name shown
on the leaderboard, lowercased with spaces/punctuation replaced by hyphens:

- "Jacob"          → `jacob.jpg`
- "Kayli Hurst"    → `kayli-hurst.jpg`
- "Michael Davis"  → `michael-davis.jpg`

`.jpg` is tried first, then `.png`. No file → the board shows initials.
Square images ≥200×200 look best (they render in a circle).

After adding/changing photos, redeploy hosting:

    firebase deploy --only hosting

Note: if an agent's display name changes (e.g. a nickname is added in
AGENT_PROFILES), rename their photo to match the new name.
