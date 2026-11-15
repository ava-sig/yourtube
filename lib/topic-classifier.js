const GENERIC_TOPICS = new Set([
  'all', 'because you searched', 'because you watched', 'continue watching', 'explore more topics',
  'for you', 'history', 'new to you', 'recently uploaded', 'recommended for you', 'shorts',
  'information', 'subscriptions', 'top news', 'videos', 'watched', 'your videos'
]);

const TOPIC_ALIASES = new Map([
  ['autos & vehicles', 'Automotive'], ['automotive', 'Automotive'], ['cars', 'Automotive'],
  ['baking', 'Food & Cooking'], ['cooking', 'Food & Cooking'], ['food', 'Food & Cooking'],
  ['business', 'Finance & Economics'], ['economics', 'Finance & Economics'], ['economy', 'Finance & Economics'],
  ['finance', 'Finance & Economics'], ['finance & business', 'Finance & Economics'],
  ['finance & economics', 'Finance & Economics'], ['investing', 'Finance & Economics'], ['stocks', 'Finance & Economics'],
  ['comedy', 'Comedy'], ['dramedy', 'Comedy'], ['satire', 'Comedy'], ['sitcoms', 'Comedy'],
  ['film & animation', 'Film & TV'], ['movies & tv', 'Film & TV'], ['science fiction', 'Film & TV'],
  ['sci-fi films', 'Film & TV'], ['superhero movies', 'Film & TV'], ['thrillers', 'Film & TV'],
  ['learning', 'Learning & Education'], ['education', 'Learning & Education'], ['presentations', 'Learning & Education'],
  ['public speaking', 'Learning & Education'], ['gaming', 'Gaming'], ['games', 'Gaming'],
  ['live', 'Live'], ['mixes', 'Music'], ['music', 'Music'], ['pop music', 'Music'],
  ['news', 'News & Politics'], ['news & politics', 'News & Politics'], ['politics', 'News & Politics'],
  ['crises', 'News & Politics'], ['democracy', 'News & Politics'],
  ['podcasts', 'Podcasts'], ['science & technology', 'Technology & AI'], ['technology & science', 'Technology & AI'],
  ['technology & ai', 'Technology & AI'], ['ai', 'Technology & AI'], ['nvidia', 'Technology & AI'],
  ['science', 'Science'], ['science & nature', 'Science'], ['sports', 'Sports'],
  ['travel & events', 'Travel'], ['travel', 'Travel'], ['pets & animals', 'Animals'], ['animals', 'Animals'],
  ['howto & style', 'Lifestyle & How-to'], ['lifestyle & how-to', 'Lifestyle & How-to'],
  ['single people', 'Relationships'], ['relationships', 'Relationships'],
  ['role-playing games', 'Gaming'], ['new wave', 'Music'], ['law enforcement', 'Crime & Justice'],
  ['crime & justice', 'Crime & Justice']
]);

const CATEGORY_TOPICS = new Map([
  ['music', 'Music'], ['gaming', 'Gaming'], ['news & politics', 'News & Politics'],
  ['comedy', 'Comedy'], ['sports', 'Sports'], ['education', 'Learning & Education'],
  ['science & technology', 'Technology & AI'], ['film & animation', 'Film & TV'],
  ['entertainment', 'Entertainment'], ['autos & vehicles', 'Automotive'],
  ['travel & events', 'Travel'], ['pets & animals', 'Animals'],
  ['howto & style', 'Lifestyle & How-to']
]);

const TEXT_RULES = [
  { topic: 'Finance & Economics', title: /\b(finance|financial|invest(?:ing|ment|ments|or)|stock(?:s| market)?|econom(?:y|ic|ics)|trading|trader|market analysis|wall street|hedge fund|federal reserve|inflation|interest rates?|mortgage|cryptocurrenc(?:y|ies)|bitcoin|venture capital|personal finance|business model|profit|revenue)\b/i, channel: /\b(econoclasts|maxinomics|economy media|thinknomy)\b/i },
  { topic: 'Comedy', title: /\b(comedy|comedian|stand[- ]?up|funny|hilarious|prank|parody|satire|roast battle|celebrity roast|sketch|sitcom|fails|key\s*&\s*peele)\b/i, tags: /\b(comedy|comedian|funny|standup|sketch comedy|satire)\b/i },
  { topic: 'Music', title: /\b(music|song|official audio|official video|lyrics|album|singer|acoustic|remix|dj set|instrumental|concert|live performance|music video|mix tape|lo[- ]?fi)\b/i, tags: /\b(music|song|singer|album|lyrics|official video|official audio|concert|remix)\b/i },
  { topic: 'Gaming', title: /\b(gameplay|gaming|gamer|playthrough|walkthrough|fortnite|minecraft|roblox|apex legends|call of duty|counter[- ]?strike|league of legends|valorant|elden ring|gta [v5])\b/i, tags: /\b(gameplay|gaming|gamer|walkthrough|fortnite|minecraft|roblox|esports)\b/i },
  { topic: 'News & Politics', title: /\b(news|breaking|politic(?:s|al)|election|parliament|congress|senate|government|president|prime minister|nato|ukraine|russia|iran|israel|protest|immigration|foreign policy|geopolitic|war in|world affairs)\b/i, tags: /\b(news|politics|election|government|nato|ukraine|russia|geopolitics)\b/i },
  { topic: 'Technology & AI', title: /\b(technology|tech companies|artificial intelligence|\bai\b|chatgpt|openai|large language model|\bllm\b|nvidia|software|programming|coding|robotics|semiconductor|data cent(?:er|re)|computer science|machine learning|chip industry)\b/i, tags: /\b(technology|artificial intelligence|\bai\b|chatgpt|openai|nvidia|software|programming|machine learning)\b/i },
  { topic: 'Film & TV', title: /\b(movie|movies|film|trailer|episode|season [0-9]|tv series|sitcom|official trailer|best moments|full episode|the office|silicon valley|key\s*&\s*peele|snl|netflix|hbo max|disney\+|superman|marvel|comicverse)\b/i, tags: /\b(movie|film|trailer|television|tv series|episode|sitcom|anime)\b/i, channel: /\b(film leak|binge flash|comicverse|hbo max|netflix)\b/i },
  { topic: 'Sports', title: /\b(sports?|football|soccer|basketball|nba|nfl|mlb|hockey|tennis|ufc|formula 1|\bf1\b|world cup|championship|match highlights|grand prix|olympics)\b/i, tags: /\b(sports?|football|soccer|basketball|nba|nfl|tennis|ufc|formula 1)\b/i },
  { topic: 'Health & Fitness', title: /\b(health|fitness|workout|exercise|nutrition|diet plan|medical|mental health|therapy|doctor|muscle building|yoga|weight loss)\b/i, tags: /\b(health|fitness|workout|exercise|nutrition|medical|mental health|yoga)\b/i },
  { topic: 'Food & Cooking', title: /\b(recipe|cooking|cook(?:ing)?|food review|chef|baking|bake|kitchen|restaurant|street food|meal prep|potato|chocolate|roast)\b/i, tags: /\b(recipe|cooking|food|chef|baking|restaurant)\b/i, channel: /\b(lebensmittel|food|cooking)\b/i },
  { topic: 'Travel', title: /\b(travel|travelling|traveling|destination|city tour|travel vlog|tourism|road trip|hotel review|flight review)\b/i, tags: /\b(travel|destination|tourism|road trip|travel vlog)\b/i },
  { topic: 'Relationships', title: /\b(date|dates|dating|relationship|married|marriage|husband|wife|boyfriend|girlfriend|\bbf\b|single moms?|single dads?|breakup|couples|women|men|feminist|parenting|family advice|kevin samuels)\b/i, tags: /\b(dating|relationships|marriage|parenting|family)\b/i, channel: /\b(kevin samuels|rich cooper|his legacy)\b/i },
  { topic: 'Learning & Education', title: /\b(tutorial|how to|explained|explainer|lesson|lecture|learn(?:ing)?|study guide|course|educational|beginners? guide|chess|civilization)\b/i, tags: /\b(tutorial|education|learning|explainer|lesson|course)\b/i, channel: /\b(infographics show|hidden mechanics|historyextra|spreading chess)\b/i },
  { topic: 'Science', title: /\b(science|scientific|physics|astronomy|biology|chemistry|space exploration|experiment|scientists?|research paper)\b/i, tags: /\b(science|physics|astronomy|biology|chemistry|research)\b/i },
  { topic: 'Automotive', title: /\b(cars?|automotive|electric vehicle|\bev\b|tesla|car review|motorsport|driving|engine|car restoration)\b/i, tags: /\b(automotive|cars?|tesla|electric vehicle|motorsport)\b/i },
  { topic: 'Style & Beauty', title: /\b(fashion|makeup|skincare|beauty routine|outfit|style guide|haircut|cosmetics)\b/i, tags: /\b(fashion|makeup|skincare|beauty|style)\b/i },
  { topic: 'Animals', title: /\b(pets?|dogs?|puppies|cats?|kittens|wildlife|animal rescue|nature documentary)\b/i, tags: /\b(pets?|dogs?|cats?|wildlife|animals?)\b/i },
  { topic: 'Crime & Justice', title: /\b(police|polizei|cops?|law enforcement|crime|criminal|courtroom|trial|detective|investigation)\b/i, tags: /\b(police|polizei|law enforcement|crime|criminal justice)\b/i },
  { topic: 'DIY & Making', title: /\b(diy|waterwheel|woodworking|self[- ]built|cabin|restoration project)\b/i, tags: /\b(diy|woodworking|maker)\b/i },
  { topic: 'Podcasts', title: /\b(podcast|podcasting|theo von|joe rogan|interview with)\b/i, tags: /\b(podcast|podcasting|interview)\b/i },
  { topic: 'Personal Growth & Spirituality', title: /\b(manifest(?:ation|ing)?|abraham hicks|self[- ]help|personal growth|mindset)\b/i, channel: /\b(abraham hicks)\b/i },
  { topic: 'Technology & AI', title: /\b(digital minds?|neural networks?|machine consciousness)\b/i },
  { topic: 'History & Culture', title: /\b(history|historical|illuminati|conspiracy|secret organization|ancient civilization|civilization|culture)\b/i, tags: /\b(history|historical|illuminati|conspiracy|culture)\b/i }
];

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const genericText = value => GENERIC_TOPICS.has(clean(value).toLocaleLowerCase());

export function normalizeTopicLabel(value) {
  const label = clean(value).replace(/[·•]+$/g, '').trim();
  if (!label || genericText(label) || /^listen in the background with youtube premium$/i.test(label) || /^(?:people\s*&\s*blogs|unknown|unavailable|channel unavailable)$/i.test(label)) return '';
  return TOPIC_ALIASES.get(label.toLocaleLowerCase()) || label.slice(0, 80);
}

export function inferVideoTopic(input = {}) {
  const explicitTopic = normalizeTopicLabel(input.topic || '');
  if (explicitTopic) return { topic: explicitTopic, source: 'captured-topic', confidence: 1 };

  const capturedLabels = [...(Array.isArray(input.capturedTopics) ? input.capturedTopics : []), input.sectionTopic || '']
    .map(normalizeTopicLabel).filter(Boolean);
  if (capturedLabels.length) return { topic: capturedLabels[0], source: 'captured-category', confidence: 0.98 };

  const categories = Array.isArray(input.categories) ? input.categories : [];
  for (const value of categories) {
    const key = clean(value).toLocaleLowerCase();
    const topic = CATEGORY_TOPICS.get(key) || normalizeTopicLabel(value);
    if (topic) return { topic, source: 'youtube-category', confidence: 0.96 };
  }

  const title = clean([input.title, input.artist, input.album, input.track].filter(Boolean).join(' '));
  const channel = clean(input.channel);
  const tags = clean(Array.isArray(input.tags) ? input.tags.join(' ') : input.tags);
  const description = clean(input.description).slice(0, 6000);
  const query = clean(Array.isArray(input.queries) ? input.queries.join(' ') : input.queries);
  const haystacks = { title, tags, query, channel, description };
  const weights = { title: 3.6, tags: 2.7, query: 3.8, channel: 3.6, description: 0.75 };
  const scores = new Map();
  const sources = new Map();
  for (const rule of TEXT_RULES) {
    let score = 0;
    const matched = [];
    for (const [source, expression] of Object.entries(rule)) {
      if (source === 'topic' || !(source in haystacks)) continue;
      if (expression.test(haystacks[source])) {
        score += weights[source];
        matched.push(source);
      }
    }
    if (score > (scores.get(rule.topic) || 0)) {
      scores.set(rule.topic, score);
      sources.set(rule.topic, matched);
    }
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 3.6) return null;
  const [topic, score] = ranked[0];
  const matched = sources.get(topic) || [];
  return {
    topic,
    source: matched.includes('tags') ? 'metadata-tags' : matched.includes('query') ? 'search-query' : 'title-and-channel',
    confidence: Math.min(0.9, Math.round((0.55 + score / 20) * 100) / 100)
  };
}
