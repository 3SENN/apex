/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Registrable domains people visit most, for lookalike checks. A
// host whose letters only resemble one of these (a Cyrillic "а" for "a", a
// "0" for "o") is shown in its raw punycode form and flagged. Apex's own list.
export const POPULAR_DOMAINS: readonly string[] = [
  'google.com', 'youtube.com', 'facebook.com', 'instagram.com', 'whatsapp.com', 'twitter.com', 'x.com',
  'wikipedia.org', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.nl', 'apple.com', 'icloud.com',
  'microsoft.com', 'live.com', 'outlook.com', 'office.com', 'bing.com', 'linkedin.com', 'netflix.com', 'reddit.com',
  'yahoo.com', 'tiktok.com', 'pinterest.com', 'twitch.tv', 'discord.com', 'telegram.org', 'zoom.us', 'slack.com',
  'github.com', 'gitlab.com', 'stackoverflow.com', 'dropbox.com', 'box.com', 'notion.so', 'figma.com', 'canva.com',
  'adobe.com', 'salesforce.com', 'shopify.com', 'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'venmo.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com', 'hsbc.com',
  'barclays.co.uk', 'santander.com', 'ing.com', 'ing.nl', 'rabobank.nl', 'abnamro.nl', 'bunq.com', 'n26.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'ebay.com', 'etsy.com', 'aliexpress.com', 'alibaba.com', 'walmart.com',
  'target.com', 'bestbuy.com', 'ikea.com', 'booking.com', 'airbnb.com', 'expedia.com', 'tripadvisor.com', 'uber.com',
  'lyft.com', 'doordash.com', 'spotify.com', 'soundcloud.com', 'deezer.com', 'disneyplus.com', 'hulu.com', 'hbomax.com',
  'primevideo.com', 'bbc.co.uk', 'bbc.com', 'cnn.com', 'nytimes.com', 'theguardian.com', 'washingtonpost.com',
  'reuters.com', 'bloomberg.com', 'wsj.com', 'forbes.com', 'medium.com', 'substack.com', 'wordpress.com', 'tumblr.com',
  'quora.com', 'imdb.com', 'yelp.com', 'craigslist.org', 'indeed.com', 'glassdoor.com', 'mozilla.org', 'firefox.com',
  'cloudflare.com', 'godaddy.com', 'namecheap.com', 'openai.com', 'anthropic.com', 'claude.ai', 'chatgpt.com',
  'duckduckgo.com', 'ecosia.org', 'brave.com', 'proton.me', 'protonmail.com', 'gmail.com', 'yandex.ru', 'baidu.com',
  'samsung.com', 'sony.com', 'nintendo.com', 'steampowered.com', 'epicgames.com', 'roblox.com', 'playstation.com',
  'xbox.com', 'docusign.com', 'intuit.com', 'turbotax.com', 'irs.gov', 'gov.uk', 'usps.com', 'ups.com', 'fedex.com',
  'dhl.com', 'postnl.nl', 'bol.com', 'marktplaats.nl', 'coolblue.nl', 'zalando.com', 'asos.com', 'hm.com', 'nike.com',
  'adidas.com', 'mail.ru', 'vk.com', 'weibo.com', 'qq.com', 'naver.com', 'line.me', 'kakao.com',
]
