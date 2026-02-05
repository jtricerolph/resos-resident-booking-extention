// Floating "SHOW ASSISTANT" button — injected into app.resos.com pages
(function () {
  const btn = document.createElement('button');
  btn.id = 'resos-ext-show-assistant';
  btn.textContent = 'SHOW ASSISTANT';

  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '999999',
    padding: '10px 20px',
    backgroundColor: '#7c6fbd',
    color: '#fff',
    border: 'none',
    borderRadius: '24px',
    fontSize: '12px',
    fontWeight: '600',
    letterSpacing: '0.5px',
    cursor: 'pointer',
    boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
    transition: 'all 0.2s ease',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    display: 'block'
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.backgroundColor = '#6b5eac';
    btn.style.transform = 'scale(1.05)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.backgroundColor = '#7c6fbd';
    btn.style.transform = 'scale(1)';
  });

  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openSidePanel' });
  });

  document.body.appendChild(btn);

  // Check if panel is already open on load
  chrome.runtime.sendMessage({ action: 'getPanelState' }, (response) => {
    if (response && response.open) {
      btn.style.display = 'none';
    }
  });

  // Listen for panel state changes from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'panelOpened') {
      btn.style.display = 'none';
    } else if (message.action === 'panelClosed') {
      btn.style.display = 'block';
    }
  });
})();
