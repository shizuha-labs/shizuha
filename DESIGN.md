# DESIGN.md - Shizuha (AI Core)

Current architecture and implementation of the AI inference engine.

## Tech Stack

- **Language**: Python 3.10+
- **LLM**: OpenAI API, Ollama (local)
- **Framework**: LangChain for tool abstraction
- **Sandbox**: RestrictedPython for safe code execution
- **Data**: yfinance, python-binance
- **Web**: BeautifulSoup, Requests

## Project Structure

```
shizuha/
├── functioncall.py        # Main entry point, tool execution
├── functions.py           # Tool definitions (@tool decorated)
├── schema.py              # Pydantic models for function calls
├── validator.py           # Function call validation
├── prompter.py            # Prompt engineering
├── infer.py               # LLM inference logic
├── config.py              # Configuration
├── utils.py               # Utilities
├── tool_call_storage.py   # Tool call persistence
├── stm.py                 # Short-term memory
├── stm_update.py          # STM updates
├── shizuha-libs/          # Utility libraries
│   └── docs/              # Library documentation
└── requirements.txt
```

## Tool Functions

| Tool | Description |
|------|-------------|
| `code_interpreter` | Execute Python code safely (RestrictedPython) |
| `google_search_and_scrape` | Search and extract web content |
| `get_current_stock_price` | Fetch stock prices (yfinance) |
| `get_crypto_price` | Fetch crypto prices (Binance) |

## Tool Definition Pattern

```python
from langchain.tools import tool

@tool
def my_tool(param: str) -> dict:
    """
    Description of the tool.

    Args:
        param: Description of parameter

    Returns:
        dict: Result data
    """
    # Implementation
    return {"result": "..."}
```

## Function Calling Flow

```
1. User query received
         ↓
2. Prompt constructed (prompter.py)
         ↓
3. LLM generates tool call
         ↓
4. Tool call validated (validator.py)
         ↓
5. Tool approval checked (ToolApprovalCache)
         ↓
6. Tool executed (functions.py)
         ↓
7. Result returned to LLM
         ↓
8. LLM generates final response
```

## Code Interpreter Sandbox

Uses RestrictedPython for safe execution:
- No file system access
- No network access
- No imports except whitelisted
- Execution timeout enforced

## Prompt Format (ChatML)

```
<|im_start|>system
You are a function calling AI model...
<tools>...</tools>
<|im_end|>
<|im_start|>user
Query here
<|im_end|>
<|im_start|>assistant
<tool_call>
{'name': 'tool_name', 'arguments': {...}}
</tool_call>
<|im_end|>
```

## Platform Integration

- Tool definitions synced with shizuha-id
- Tool calls audited in shizuha-id (ToolCall model)
