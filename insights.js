// ─── Spending Insights Engine ────────────────────────────────────────────────
// Generates embedded spending narratives + graph-based pattern discovery.
// Tier 2: Voyage AI embeddings stored in pgvector for semantic search.
// Tier 3: graphology in-memory graph for spending cluster detection.

const { createClient } = require('@supabase/supabase-js');
const { VoyageAIClient } = require('voyageai');
const Graph = require('graphology');
const louvain = require('graphology-communities-louvain');
const { centrality } = require('graphology-metrics');
const { client: anthropicClient, callWithRetry } = require('./anthropic-client');
const { isCommitted, getCategoryEmoji } = require('./constants');

// ─── Clients (lazy init — avoids crash when env vars missing in tests) ──────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

let voyage = null;
function getVoyageClient() {
  if (!voyage && process.env.VOYAGE_API_KEY) {
    voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });
  }
  return voyage;
}

const EMBED_MODEL = 'voyage-finance-2';
const EMBED_DIMS = 1024;

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 2: Narrative Generation + Embedding
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a weekly spending narrative for a user using Claude Haiku.
 * Returns a human-readable paragraph summarising the week's spending.
 */
async function generateWeeklyNarrative(phone, weekStart, weekEnd) {
  // Fetch expenses for the week
  const { data: expenses, error } = await getSupabase().from('expenses')
    .select('date, amount, category, merchant')
    .eq('phone', phone)
    .gte('date', weekStart.toISOString().split('T')[0])
    .lte('date', weekEnd.toISOString().split('T')[0])
    .order('date', { ascending: true });

  if (error || !expenses || expenses.length === 0) return null;

  // Build summary stats
  const byCategory = {};
  const byMerchant = {};
  let total = 0;
  for (const e of expenses) {
    const amt = parseFloat(e.amount);
    total += amt;
    byCategory[e.category] = (byCategory[e.category] || 0) + amt;
    if (e.merchant) {
      byMerchant[e.merchant] = (byMerchant[e.merchant] || { count: 0, total: 0 });
      byMerchant[e.merchant].count++;
      byMerchant[e.merchant].total += amt;
    }
  }

  const topCats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMerchants = Object.entries(byMerchant).sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  const fmtDate = d => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

  const prompt = `Write a 2-3 sentence spending summary for the week of ${fmtDate(weekStart)} to ${fmtDate(weekEnd)}.

Total: Rs.${Math.round(total).toLocaleString('en-IN')} across ${expenses.length} transactions.
Top categories: ${topCats.map(([c, a]) => `${c}: Rs.${Math.round(a).toLocaleString('en-IN')}`).join(', ')}
Top merchants: ${topMerchants.map(([m, d]) => `${m} (${d.count}x, Rs.${Math.round(d.total).toLocaleString('en-IN')})`).join(', ')}

Write as a factual spending snapshot — no advice. Include amounts and merchant names. Plain text, no formatting.`;

  try {
    const response = await callWithRetry(() => anthropicClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    }));
    return response.content[0].text.trim();
  } catch (err) {
    console.error('[insights] Narrative generation failed:', err.message);
    // Fallback: build a simple narrative without Claude
    return `Week of ${fmtDate(weekStart)}: Rs.${Math.round(total).toLocaleString('en-IN')} across ${expenses.length} transactions. ` +
      `Top: ${topCats.slice(0, 3).map(([c, a]) => `${c} Rs.${Math.round(a).toLocaleString('en-IN')}`).join(', ')}. ` +
      (topMerchants.length > 0 ? `Frequent: ${topMerchants.slice(0, 3).map(([m, d]) => `${m} ${d.count}x`).join(', ')}.` : '');
  }
}

/**
 * Embed text using Voyage AI voyage-finance-2.
 * Returns float array of EMBED_DIMS dimensions, or null if unavailable.
 */
async function embedText(text) {
  const client = getVoyageClient();
  if (!client) return null;

  try {
    const result = await client.embed({
      input: [text],
      model: EMBED_MODEL
    });
    return result.data[0].embedding;
  } catch (err) {
    console.error('[insights] Embedding failed:', err.message);
    return null;
  }
}

/**
 * Store a narrative with its embedding in the spending_narratives table.
 * Upserts based on phone + narrative_type + period_start.
 */
async function storeNarrative(phone, type, periodStart, periodEnd, content, metadata) {
  const embedding = await embedText(content);

  // Check if narrative already exists for this period
  const { data: existing } = await getSupabase().from('spending_narratives')
    .select('id')
    .eq('phone', phone)
    .eq('narrative_type', type)
    .eq('period_start', periodStart.toISOString().split('T')[0])
    .maybeSingle();

  const row = {
    phone,
    narrative_type: type,
    period_start: periodStart.toISOString().split('T')[0],
    period_end: periodEnd.toISOString().split('T')[0],
    content,
    metadata: metadata || {},
    updated_at: new Date().toISOString()
  };

  // Only include embedding if we got one (Voyage API key may not be set)
  if (embedding) row.embedding = JSON.stringify(embedding);

  if (existing) {
    await getSupabase().from('spending_narratives').update(row).eq('id', existing.id);
  } else {
    row.created_at = new Date().toISOString();
    await getSupabase().from('spending_narratives').insert(row);
  }
}

/**
 * Generate and store weekly narratives for a user.
 * Generates for the last N weeks that don't already have narratives.
 */
async function generateNarrativesForUser(phone, weeksBack) {
  const n = weeksBack || 4;
  const now = new Date();
  let generated = 0;

  for (let w = 0; w < n; w++) {
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() - (w * 7));
    weekEnd.setHours(23, 59, 59, 999);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    // Check if narrative already exists
    const { data: existing } = await getSupabase().from('spending_narratives')
      .select('id')
      .eq('phone', phone)
      .eq('narrative_type', 'weekly_summary')
      .eq('period_start', weekStart.toISOString().split('T')[0])
      .maybeSingle();

    if (existing) continue; // already generated

    const narrative = await generateWeeklyNarrative(phone, weekStart, weekEnd);
    if (!narrative) continue;

    await storeNarrative(phone, 'weekly_summary', weekStart, weekEnd, narrative, {});
    generated++;
  }

  return generated;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 2: Semantic Search
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Search for relevant spending narratives using vector similarity.
 * Falls back to recent narratives by date if embeddings unavailable.
 */
async function searchNarratives(phone, query, limit) {
  const k = limit || 5;

  // Try vector search first
  const queryEmbedding = await embedText(query);
  if (queryEmbedding) {
    const { data, error } = await getSupabase().rpc('match_narratives', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_phone: phone,
      match_count: k
    });

    if (!error && data && data.length > 0) {
      return data.map(r => ({
        content: r.content,
        type: r.narrative_type,
        periodStart: r.period_start,
        similarity: r.similarity
      }));
    }
  }

  // Fallback: most recent narratives by date
  const { data, error } = await getSupabase().from('spending_narratives')
    .select('content, narrative_type, period_start')
    .eq('phone', phone)
    .order('period_start', { ascending: false })
    .limit(k);

  if (error || !data) return [];
  return data.map(r => ({
    content: r.content,
    type: r.narrative_type,
    periodStart: r.period_start,
    similarity: null
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER 3: Spending Graph — Pattern Discovery via graphology
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an in-memory spending graph for a user.
 * Nodes: merchants, categories, day-of-week slots
 * Edges: weighted by spend amount and co-occurrence
 */
async function buildSpendingGraph(phone) {
  // Fetch last 90 days of expenses
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  const { data: expenses, error } = await getSupabase().from('expenses')
    .select('date, amount, category, merchant')
    .eq('phone', phone)
    .gte('date', cutoff.toISOString().split('T')[0])
    .order('date', { ascending: true });

  if (error || !expenses || expenses.length < 10) return null;

  const graph = new Graph({ multi: false, type: 'undirected' });
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Add nodes and edges
  for (const e of expenses) {
    const amt = parseFloat(e.amount);
    const cat = e.category || 'Other';
    const merchant = e.merchant || null;
    const dow = dayNames[new Date(e.date).getDay()];

    // Category node
    if (!graph.hasNode(cat)) {
      graph.addNode(cat, { type: 'category', totalSpend: 0, txCount: 0 });
    }
    graph.updateNodeAttribute(cat, 'totalSpend', v => v + amt);
    graph.updateNodeAttribute(cat, 'txCount', v => v + 1);

    // Day-of-week node
    const dowNode = 'dow:' + dow;
    if (!graph.hasNode(dowNode)) {
      graph.addNode(dowNode, { type: 'day', totalSpend: 0, txCount: 0 });
    }
    graph.updateNodeAttribute(dowNode, 'totalSpend', v => v + amt);
    graph.updateNodeAttribute(dowNode, 'txCount', v => v + 1);

    // Category <-> Day edge
    const catDowEdge = cat + '|' + dowNode;
    if (!graph.hasEdge(cat, dowNode)) {
      graph.addEdge(cat, dowNode, { weight: 0, txCount: 0 });
    }
    graph.updateEdgeAttribute(cat, dowNode, 'weight', v => v + amt);
    graph.updateEdgeAttribute(cat, dowNode, 'txCount', v => v + 1);

    // Merchant node + edges
    if (merchant) {
      const merchNode = 'merch:' + merchant;
      if (!graph.hasNode(merchNode)) {
        graph.addNode(merchNode, { type: 'merchant', totalSpend: 0, txCount: 0 });
      }
      graph.updateNodeAttribute(merchNode, 'totalSpend', v => v + amt);
      graph.updateNodeAttribute(merchNode, 'txCount', v => v + 1);

      // Merchant <-> Category
      if (!graph.hasEdge(merchNode, cat)) {
        graph.addEdge(merchNode, cat, { weight: 0, txCount: 0 });
      }
      graph.updateEdgeAttribute(merchNode, cat, 'weight', v => v + amt);
      graph.updateEdgeAttribute(merchNode, cat, 'txCount', v => v + 1);

      // Merchant <-> Day
      if (!graph.hasEdge(merchNode, dowNode)) {
        graph.addEdge(merchNode, dowNode, { weight: 0, txCount: 0 });
      }
      graph.updateEdgeAttribute(merchNode, dowNode, 'weight', v => v + amt);
      graph.updateEdgeAttribute(merchNode, dowNode, 'txCount', v => v + 1);
    }
  }

  return graph;
}

/**
 * Run community detection and centrality analysis on the spending graph.
 * Returns discovered patterns as text insights.
 */
function analyzeSpendingGraph(graph) {
  if (!graph || graph.order < 5) return [];

  const insights = [];

  // Community detection (Louvain) — finds spending clusters
  try {
    const communities = louvain(graph, { getEdgeWeight: 'weight' });
    // Group nodes by community
    const groups = {};
    graph.forEachNode((node, attrs) => {
      const comm = communities[node];
      if (!groups[comm]) groups[comm] = [];
      groups[comm].push({ node, ...attrs });
    });

    // Describe each community with 2+ members
    for (const [commId, members] of Object.entries(groups)) {
      if (members.length < 2) continue;
      const categories = members.filter(m => m.type === 'category');
      const merchants = members.filter(m => m.type === 'merchant');
      const days = members.filter(m => m.type === 'day');

      if (categories.length === 0) continue;

      const catNames = categories.map(c => c.node).join(', ');
      const merchNames = merchants.slice(0, 3).map(m => m.node.replace('merch:', '')).join(', ');
      const dayNames = days.map(d => d.node.replace('dow:', '')).join(', ');
      const totalSpend = categories.reduce((s, c) => s + c.totalSpend, 0);

      let desc = `Spending cluster: ${catNames} (Rs.${Math.round(totalSpend).toLocaleString('en-IN')} total)`;
      if (merchNames) desc += `. Merchants: ${merchNames}`;
      if (dayNames) desc += `. Peaks on: ${dayNames}`;
      insights.push(desc);
    }
  } catch (err) {
    console.error('[insights] Community detection failed:', err.message);
  }

  // Degree centrality — which nodes are most connected
  try {
    const degreeCentrality = centrality.degree(graph);
    const sorted = Object.entries(degreeCentrality)
      .filter(([node]) => !node.startsWith('dow:')) // skip day nodes
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (sorted.length > 0) {
      const hubs = sorted.map(([node, score]) => {
        const attrs = graph.getNodeAttributes(node);
        const name = node.startsWith('merch:') ? node.replace('merch:', '') : node;
        return `${name} (${attrs.txCount}x, Rs.${Math.round(attrs.totalSpend).toLocaleString('en-IN')})`;
      }).join(', ');
      insights.push(`Spending hubs: ${hubs}`);
    }
  } catch (err) {
    console.error('[insights] Centrality analysis failed:', err.message);
  }

  // Weekend vs weekday spending pattern
  try {
    let weekdaySpend = 0, weekendSpend = 0;
    graph.forEachNode((node, attrs) => {
      if (attrs.type !== 'day') return;
      const day = node.replace('dow:', '');
      if (day === 'Sat' || day === 'Sun') weekendSpend += attrs.totalSpend;
      else weekdaySpend += attrs.totalSpend;
    });
    if (weekdaySpend > 0 && weekendSpend > 0) {
      const weekdayAvg = Math.round(weekdaySpend / 5);
      const weekendAvg = Math.round(weekendSpend / 2);
      const ratio = weekendAvg / weekdayAvg;
      if (ratio > 1.5) {
        insights.push(`Weekend spending is ${ratio.toFixed(1)}x higher than weekdays (Rs.${weekendAvg.toLocaleString('en-IN')}/day vs Rs.${weekdayAvg.toLocaleString('en-IN')}/day)`);
      } else if (ratio < 0.6) {
        insights.push(`Weekday spending dominates: Rs.${weekdayAvg.toLocaleString('en-IN')}/day vs Rs.${weekendAvg.toLocaleString('en-IN')}/day on weekends`);
      }
    }
  } catch (err) { /* non-critical */ }

  return insights;
}

/**
 * Full graph analysis pipeline: build graph → analyze → store insights.
 */
async function generateGraphInsights(phone) {
  const graph = await buildSpendingGraph(phone);
  if (!graph) return 0;

  const patterns = analyzeSpendingGraph(graph);
  if (patterns.length === 0) return 0;

  const now = new Date();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const content = patterns.join('\n');

  await storeNarrative(phone, 'graph_insight', cutoff, now, content, {
    patterns: patterns.length,
    nodes: graph.order,
    edges: graph.size
  });

  return patterns.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR — run all insight generation for a user
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate all insights for a user (narratives + graph patterns).
 * Called by the heartbeat scheduler.
 */
async function generateAllInsights(phone) {
  const results = { narratives: 0, graphPatterns: 0 };

  try {
    results.narratives = await generateNarrativesForUser(phone, 4);
  } catch (err) {
    console.error('[insights] Narrative generation failed for', phone, err.message);
  }

  try {
    results.graphPatterns = await generateGraphInsights(phone);
  } catch (err) {
    console.error('[insights] Graph analysis failed for', phone, err.message);
  }

  if (results.narratives > 0 || results.graphPatterns > 0) {
    console.log('[insights]', phone, '— generated', results.narratives, 'narratives,', results.graphPatterns, 'graph patterns');
  }

  return results;
}

module.exports = {
  // Narrative generation
  generateWeeklyNarrative,
  generateNarrativesForUser,
  storeNarrative,
  // Embedding
  embedText,
  // Semantic search
  searchNarratives,
  // Graph analysis
  buildSpendingGraph,
  analyzeSpendingGraph,
  generateGraphInsights,
  // Orchestrator
  generateAllInsights,
  // Constants
  EMBED_MODEL,
  EMBED_DIMS
};
