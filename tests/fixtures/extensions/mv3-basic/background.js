// The fixture's worker: a badge on start, and a reply to the smoke check's ping.
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '3' })
  chrome.action.setBadgeBackgroundColor({ color: '#2f6b4f' })
})
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message && message.type === 'ping') reply({ type: 'pong', id: chrome.runtime.id })
})
