// Open (or focus) the filler page tab when the extension icon is clicked.
chrome.action.onClicked.addListener(async () => {
  const pageUrl = chrome.runtime.getURL('page.html');
  const [existing] = await chrome.tabs.query({ url: pageUrl });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: pageUrl });
  }
});
