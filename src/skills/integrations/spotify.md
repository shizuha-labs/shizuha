# Spotify Integration

Control Spotify playback via the Spotify Web API. Requires SPOTIFY_ACCESS_TOKEN.

## Setup
```bash
# Get token from https://developer.spotify.com/console/
export SPOTIFY_ACCESS_TOKEN="BQD..."
```

## Common Operations

### Now Playing
```bash
curl -s "https://api.spotify.com/v1/me/player/currently-playing" \
  -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'Now playing: {d[\"item\"][\"name\"]} by {d[\"item\"][\"artists\"][0][\"name\"]}')"
```

### Search
```bash
curl -s "https://api.spotify.com/v1/search?q=QUERY&type=track&limit=5" \
  -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN"
```

### Playback Control
```bash
# Play/Resume
curl -s -X PUT "https://api.spotify.com/v1/me/player/play" \
  -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN"

# Pause
curl -s -X PUT "https://api.spotify.com/v1/me/player/pause" \
  -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN"

# Next track
curl -s -X POST "https://api.spotify.com/v1/me/player/next" \
  -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN"

# Set volume (0-100)
curl -s -X PUT "https://api.spotify.com/v1/me/player/volume?volume_percent=50" \
  -H "Authorization: Bearer $SPOTIFY_ACCESS_TOKEN"
```
