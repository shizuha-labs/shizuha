(() => {
  const vscode = acquireVsCodeApi();
  const turnsEl = document.getElementById('turns');
  const form = document.getElementById('composer');
  const input = document.getElementById('message');
  const sendBtn = document.getElementById('send');
  const cancelBtn = document.getElementById('cancel');
  const statusEl = document.getElementById('status');
  const modelEl = document.getElementById('model');
  const providerEl = document.getElementById('provider');

  let lastRetry = '';

  function div(cls, text) {
    const el = document.createElement('div');
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function render(state) {
    statusEl.textContent = state.runStatus || 'idle';
    if (state.pendingDiffCount > 0) {
      statusEl.textContent += ' (' + state.pendingDiffCount + ' diff' + (state.pendingDiffCount > 1 ? 's' : '') + ' pending)';
    }
    input.disabled = !!state.streaming;
    sendBtn.disabled = !!state.streaming;
    cancelBtn.disabled = !state.streaming;
    turnsEl.replaceChildren();
    (state.turns || []).forEach((turn) => {
      const row = div(`turn ${turn.role}`);
      row.appendChild(div('role', turn.role));
      row.appendChild(div('content', turn.content || (turn.role === 'assistant' ? '…' : '')));
      (turn.tools || []).forEach((tool) => {
        const details = document.createElement('details');
        details.className = 'tool';
        const summary = document.createElement('summary');
        summary.textContent = `${tool.kind}: ${tool.name || tool.id}`;
        const pre = document.createElement('pre');
        pre.textContent = typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content, null, 2);
        details.append(summary, pre);
        row.appendChild(details);
      });
      (turn.diffs || []).forEach((diff) => {
        const block = document.createElement('div');
        block.className = 'diff-block' + (diff.action ? ' diff-' + diff.action : '');
        const header = document.createElement('div');
        header.className = 'diff-header';
        header.textContent = diff.diff.description || 'Edit: ' + diff.diff.file_path;
        block.appendChild(header);
        const fileLabel = document.createElement('div');
        fileLabel.className = 'diff-file';
        fileLabel.textContent = diff.diff.file_path;
        block.appendChild(fileLabel);
        if (diff.diff.unsupported) {
          const unsup = document.createElement('div');
          unsup.className = 'diff-unsupported';
          unsup.textContent = diff.diff.unsupported_reason || 'File too large or binary for preview.';
          block.appendChild(unsup);
        } else if (diff.diff.proposed_content) {
          const pre = document.createElement('pre');
          pre.className = 'diff-content';
          pre.textContent = diff.diff.proposed_content;
          block.appendChild(pre);
        }
        if (!diff.action) {
          const actions = document.createElement('div');
          actions.className = 'diff-actions';
          const acceptBtn = document.createElement('button');
          acceptBtn.type = 'button';
          acceptBtn.className = 'diff-accept';
          acceptBtn.textContent = 'Accept';
          acceptBtn.addEventListener('click', () => vscode.postMessage({ type: 'acceptDiff', diffId: diff.id }));
          const rejectBtn = document.createElement('button');
          rejectBtn.type = 'button';
          rejectBtn.className = 'diff-reject';
          rejectBtn.textContent = 'Reject';
          rejectBtn.addEventListener('click', () => vscode.postMessage({ type: 'rejectDiff', diffId: diff.id }));
          actions.append(acceptBtn, rejectBtn);
          block.appendChild(actions);
        } else {
          const badge = document.createElement('span');
          badge.className = 'diff-badge diff-badge-' + diff.action;
          badge.textContent = diff.action;
          block.appendChild(badge);
        }
        row.appendChild(block);
      });
      if (turn.error) {
        const error = div('error');
        const code = div('error-code', turn.error.code || 'ERROR');
        const msg = div('error-message', turn.error.message || 'Unknown error');
        error.append(code, msg);
        if (turn.error.request_id) error.appendChild(div('error-request', `request: ${turn.error.request_id}`));
        if (turn.error.details !== undefined) {
          const details = document.createElement('pre');
          details.className = 'error-details';
          details.textContent = typeof turn.error.details === 'string' ? turn.error.details : JSON.stringify(turn.error.details, null, 2);
          error.appendChild(details);
        }
        if (turn.error.retryable) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.textContent = 'Retry';
          retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
          error.appendChild(retry);
        }
        row.appendChild(error);
      }
      turnsEl.appendChild(row);
    });
    turnsEl.scrollTop = turnsEl.scrollHeight;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    lastRetry = content;
    vscode.postMessage({ type: 'submit', content, model: modelEl.value.trim(), provider: providerEl.value.trim() });
    input.value = '';
  });
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'state') render(msg.state || {});
    if (msg.type === 'retry-content' && !input.value) input.value = lastRetry;
  });

  vscode.postMessage({ type: 'ready' });
})();
