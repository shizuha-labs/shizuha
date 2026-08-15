---
name: shizuha-wiki
description: Wiki documentation — UPSERT pages (search before create), spaces, labels, content management
tags:
  - wiki
  - documentation
  - shizuha
---

# Shizuha Wiki Integration

Use the `shizuha-wiki` MCP tools for documentation management. Authenticated via `SHIZUHA_USERNAME` / `SHIZUHA_PASSWORD` (JWT obtained automatically).

## UPSERT Pattern — Never Create Duplicates

Before creating ANY page, always search first:

```
1. wiki_list_pages(space_id="SPACE_ID") → see existing pages
2. wiki_search_pages(query="topic") → find related content
3. If exists → wiki_update_page(page_id, ...)
4. If missing → wiki_create_page(...)
```

## Common Operations

### Spaces
```
wiki_list_spaces()                    # List all spaces
wiki_get_space(space_id)              # Space details
wiki_get_space_tree(space_id)         # Page hierarchy
```

### Pages (CRUD)
```
wiki_create_page(space_id, title, content_text, status="published")
wiki_update_page(page_id, content_text=..., title=..., expected_version=N)
wiki_get_page(page_id)               # Full page content (includes Version: N)
wiki_list_pages(space_id)             # List pages in space
wiki_search_pages(query, space_id)    # Full-text search
wiki_delete_page(page_id)             # Delete page
```

## Optimistic Concurrency Guard — Always Pass `expected_version`

`wiki_update_page` supports an `expected_version` parameter for safe concurrent editing. When provided, the save is **rejected with a 409 conflict** if someone else edited the page since you read it, instead of silently overwriting their changes.

**Always use the guard for co-edited pages:**
```
1. page = wiki_get_page(page_id)     # note the "Version: N" line in the output
2. wiki_update_page(
       page_id,
       content_text="...",
       expected_version=N             # pass the version you read
   )
# On conflict → 409 ⚠️ with current_version M
3. page = wiki_get_page(page_id)     # re-pull at version M
4. wiki_update_page(..., expected_version=M)   # re-apply and save
```

Omit `expected_version` **only** for a deliberate unconditional overwrite (rare).

### Labels & Organization
```
wiki_list_labels()                    # All labels
wiki_create_label(name, color)        # Create label
```

## Content Format

Pages accept markdown in `content_text`. The wiki automatically converts to TipTap JSON for rendering. Use:
- Headings (`##`, `###`)
- Code blocks with language tags (` ```python `)
- Tables (`| col1 | col2 |`)
- Bold (`**text**`), inline code (`` `code` ``), links (`[text](url)`)

## Documentation Standards

- One topic per page, split if over 8000 chars
- Cross-reference related pages by title
- Include practical code examples, not just descriptions
- Verify code references exist in the actual source before documenting
