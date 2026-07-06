chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'FWIW_GET_SELECTION') {
    sendResponse({
      text: String(window.getSelection ? window.getSelection().toString() : ''),
      url: location.href,
      title: document.title
    });
  }
  return true;
});
