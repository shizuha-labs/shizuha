# Notion Integration

Use the Notion API via curl. Requires NOTION_API_KEY environment variable.

## Setup
```bash
# Set API key (get from https://www.notion.so/my-integrations)
export NOTION_API_KEY="secret_..."
```

## Common Operations

### Search
```bash
curl -s -X POST 'https://api.notion.com/v1/search' \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "search term", "page_size": 5}'
```

### Get Page
```bash
curl -s "https://api.notion.com/v1/pages/PAGE_ID" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28"
```

### Create Page
```bash
curl -s -X POST 'https://api.notion.com/v1/pages' \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "DATABASE_ID"},
    "properties": {
      "Name": {"title": [{"text": {"content": "New Page"}}]}
    }
  }'
```

### Get Database
```bash
curl -s -X POST "https://api.notion.com/v1/databases/DATABASE_ID/query" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"page_size": 10}'
```

## Notes
- All API calls use Notion API v2022-06-28
- Page IDs are UUIDs (32 hex chars, often shown with dashes)
- Database IDs can be found in the URL when viewing a database
