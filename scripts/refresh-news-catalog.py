#!/usr/bin/env python3
"""Refresh the news catalog from HN + Reddit. Run via cron every 30 minutes."""

import json, urllib.request, time, os

CATALOG_PATH = os.path.expanduser("~/.shizuha/shared/news-catalog.json")
BACKUP_PATH = os.path.expanduser("~/.shizuha/workspaces/nori/news-catalog.json")

# Load existing catalog
catalog = {"last_updated": "", "items": []}
try:
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)
except: pass

existing_urls = {i['url'] for i in catalog.get('items', [])}

# Fetch HN
new_items = []
try:
    top_ids = json.loads(urllib.request.urlopen("https://hacker-news.firebaseio.com/v0/topstories.json", timeout=10).read())[:25]
    for sid in top_ids:
        try:
            s = json.loads(urllib.request.urlopen(f"https://hacker-news.firebaseio.com/v0/item/{sid}.json", timeout=5).read())
            if not s or s.get('type') != 'story': continue
            url = s.get('url', f"https://news.ycombinator.com/item?id={sid}")
            if url in existing_urls: continue
            if s.get('score', 0) < 50: continue
            
            new_items.append({
                'id': f'hn_{sid}', 'title': s.get('title',''), 'url': url,
                'source': 'hackernews', 'score': s.get('score',0),
                'comments': s.get('descendants',0), 'category': 'tech',
                'tweet_angle': '', 'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'posted': False
            })
        except: continue
        time.sleep(0.1)
except Exception as e:
    print(f"HN error: {e}")

# Fetch Reddit
try:
    req = urllib.request.Request(
        "https://www.reddit.com/r/programming+artificial+ClaudeAI+MachineLearning+technology/hot.json?limit=20",
        headers={"User-Agent": "Scout/1.0"}
    )
    data = json.loads(urllib.request.urlopen(req, timeout=10).read())
    for post in data.get('data',{}).get('children',[]):
        p = post.get('data',{})
        url = f"https://reddit.com{p.get('permalink','')}"
        if url in existing_urls: continue
        if p.get('score',0) < 30: continue
        if p.get('over_18'): continue
        
        new_items.append({
            'id': f'reddit_{p.get("id","")}', 'title': p.get('title',''), 'url': url,
            'source': f'reddit/r/{p.get("subreddit","")}', 'score': p.get('score',0),
            'comments': p.get('num_comments',0), 'category': 'tech',
            'tweet_angle': '', 'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'posted': False
        })
except Exception as e:
    print(f"Reddit error: {e}")

# Merge: add new items, keep top 50
catalog['items'].extend(new_items)
catalog['items'].sort(key=lambda x: x.get('score',0), reverse=True)
catalog['items'] = catalog['items'][:50]
catalog['last_updated'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

# Save
for path in [CATALOG_PATH, BACKUP_PATH]:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(catalog, f, indent=2)

print(f"Catalog: {len(catalog['items'])} items (+{len(new_items)} new)")
