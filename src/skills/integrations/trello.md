# Trello Integration

Use the Trello API via curl. Requires TRELLO_API_KEY and TRELLO_TOKEN.

## Setup
```bash
# Get API key from https://trello.com/power-ups/admin
export TRELLO_API_KEY="your_key"
# Get token from https://trello.com/1/authorize?key=YOUR_KEY&scope=read,write&response_type=token&expiration=never
export TRELLO_TOKEN="your_token"
```

## Common Operations

### Boards
```bash
# List your boards
curl -s "https://api.trello.com/1/members/me/boards?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" | python3 -c "import sys,json; [print(f'{b[\"id\"]}: {b[\"name\"]}') for b in json.load(sys.stdin)]"

# Get board lists
curl -s "https://api.trello.com/1/boards/BOARD_ID/lists?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN"
```

### Cards
```bash
# List cards on a board
curl -s "https://api.trello.com/1/boards/BOARD_ID/cards?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN"

# Create card
curl -s -X POST "https://api.trello.com/1/cards?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" \
  -d "idList=LIST_ID&name=Card Title&desc=Description"

# Move card to another list
curl -s -X PUT "https://api.trello.com/1/cards/CARD_ID?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" \
  -d "idList=NEW_LIST_ID"

# Add comment
curl -s -X POST "https://api.trello.com/1/cards/CARD_ID/actions/comments?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" \
  -d "text=Comment text"
```
