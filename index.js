const express = require("express");
const cors = require("cors");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ITEM_PREFIX = "item:";
const OWNED_PREFIX = "owned:";
const ADMIN_KEY = "hedgehog-store-2026";

const BROWSER_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Accept": "text/plain,text/html,application/xhtml+xml,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
	"Referer": "https://pastebin.com/"
};

function requireAdmin(req, res, next) {
	const key = req.headers["x-admin-key"];
	if (!ADMIN_KEY) {
		return res.status(500).json({ success: false, error: "HEDGEHOG_ADMIN_KEY non configurée côté serveur" });
	}
	if (key !== ADMIN_KEY) {
		return res.status(401).json({ success: false, error: "Clé admin invalide ou manquante (header x-admin-key)" });
	}
	next();
}

async function getItem(itemId) {
	const raw = await redis.get(`${ITEM_PREFIX}${itemId}`);
	if (!raw) return null;
	return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function saveItem(itemId, data) {
	await redis.set(`${ITEM_PREFIX}${itemId}`, JSON.stringify(data));
}

async function getAllItems() {
	const keys = await redis.keys(`${ITEM_PREFIX}*`);
	const items = [];
	for (const key of keys) {
		const raw = await redis.get(key);
		const item = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (item) items.push(item);
	}
	return items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

async function getOwned(userId) {
	const raw = await redis.get(`${OWNED_PREFIX}${userId}`);
	if (!raw) return [];
	return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function saveOwned(userId, list) {
	await redis.set(`${OWNED_PREFIX}${userId}`, JSON.stringify(list));
}

async function fetchPastebinRaw(pastebinId) {
	const url = `https://pastebin.com/raw/${pastebinId}`;
	let lastStatus = null;

	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await fetch(url, { headers: BROWSER_HEADERS });
		lastStatus = response.status;
		if (response.ok) {
			return { ok: true, text: await response.text() };
		}
		if (response.status !== 429 && response.status !== 403) break;
	}

	return { ok: false, status: lastStatus };
}

app.get("/", (req, res) => {
	res.json({
		message: "Hedgehog Market API opérationnelle",
		version: "1.2",
		endpoints: {
			"GET /api/market/items": "Liste tous les items en vente",
			"GET /api/market/items/:itemId": "Détail d'un item",
			"POST /api/market/items": "Ajouter un item (admin, header x-admin-key)",
			"POST /api/market/import-github": "Importer les .js d'un dossier GitHub (admin)",
			"POST /api/market/upload-inline": "Uploader un fichier local directement (admin)",
			"POST /api/market/items/:itemId/like": "Liker un item { userId }",
			"GET /api/market/status": "Statistiques globales du marketplace",
			"PUT /api/market/items/:itemId": "Modifier un item (admin)",
			"DELETE /api/market/items/:itemId": "Supprimer un item (admin)",
			"POST /api/market/purchase": "Enregistrer un achat { userId, itemId, userName }",
			"GET /api/market/owns/:userId/:itemId": "Vérifie si un user possède un item",
			"GET /api/market/inventory/:userId": "Liste les items possédés par un user",
			"GET /raw/:itemId": "Contenu brut de la commande (proxy Pastebin)"
		}
	});
});

app.get("/api/market/items", async (req, res) => {
	try {
		const items = await getAllItems();
		res.json({ success: true, data: items });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/market/items/:itemId", async (req, res) => {
	try {
		const item = await getItem(req.params.itemId);
		if (!item) return res.status(404).json({ success: false, error: "Item introuvable" });
		if (req.query.view !== "false") {
			item.views = (item.views || 0) + 1;
			await saveItem(req.params.itemId, item);
		}
		res.json({ success: true, data: item });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.post("/api/market/items/:itemId/like", async (req, res) => {
	const { userId } = req.body;
	if (!userId) return res.status(400).json({ success: false, error: "userId requis" });
	try {
		const item = await getItem(req.params.itemId);
		if (!item) return res.status(404).json({ success: false, error: "Item introuvable" });

		const likedBy = item.likedBy || [];
		if (likedBy.includes(userId)) {
			return res.json({ success: true, data: { alreadyLiked: true, likes: item.likes || 0 } });
		}

		likedBy.push(userId);
		item.likedBy = likedBy;
		item.likes = likedBy.length;
		await saveItem(req.params.itemId, item);

		res.json({ success: true, data: { alreadyLiked: false, likes: item.likes } });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/market/status", async (req, res) => {
	try {
		const items = await getAllItems();
		const totalItems = items.length;
		const totalSales = items.reduce((sum, it) => sum + (it.sales || 0), 0);
		const totalViews = items.reduce((sum, it) => sum + (it.views || 0), 0);
		const totalLikes = items.reduce((sum, it) => sum + (it.likes || 0), 0);

		const mostSold = [...items].sort((a, b) => (b.sales || 0) - (a.sales || 0))[0] || null;
		const mostLiked = [...items].sort((a, b) => (b.likes || 0) - (a.likes || 0))[0] || null;
		const mostViewed = [...items].sort((a, b) => (b.views || 0) - (a.views || 0))[0] || null;

		res.json({
			success: true,
			data: {
				totalItems,
				totalSales,
				totalViews,
				totalLikes,
				mostSold: mostSold ? { itemId: mostSold.itemId, name: mostSold.name, sales: mostSold.sales || 0 } : null,
				mostLiked: mostLiked ? { itemId: mostLiked.itemId, name: mostLiked.name, likes: mostLiked.likes || 0 } : null,
				mostViewed: mostViewed ? { itemId: mostViewed.itemId, name: mostViewed.name, views: mostViewed.views || 0 } : null
			}
		});
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.post("/api/market/items", requireAdmin, async (req, res) => {
	const { itemId, name, description, price, category, source, ref } = req.body;
	if (!itemId || !name || typeof price !== "number" || Number.isNaN(price) || price < 0) {
		return res.status(400).json({ success: false, error: "itemId, name et price (nombre positif) sont requis" });
	}
	try {
		const existing = await getItem(itemId);
		const item = {
			itemId,
			name,
			description: description || "",
			price,
			category: category || "goatbot",
			source: source === "github" ? "github" : "pastebin",
			ref: ref || itemId,
			sales: existing?.sales || 0,
			createdAt: existing?.createdAt || Date.now(),
			updatedAt: Date.now()
		};
		await saveItem(itemId, item);
		res.json({ success: true, data: item });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

const CODE_PREFIX = "code:";

app.post("/api/market/upload-inline", requireAdmin, async (req, res) => {
	const { itemId, name, description, price, code, category, authorName } = req.body;
	if (!itemId || !name || !code || typeof price !== "number" || Number.isNaN(price) || price < 0) {
		return res.status(400).json({ success: false, error: "itemId, name, code et price (nombre) sont requis" });
	}
	try {
		const existing = await getItem(itemId);
		const item = {
			itemId,
			name,
			description: description || "",
			price,
			category: category || "goatbot",
			authorName: authorName || "",
			source: "inline",
			ref: itemId,
			views: existing?.views || 0,
			likes: existing?.likes || 0,
			likedBy: existing?.likedBy || [],
			sales: existing?.sales || 0,
			createdAt: existing?.createdAt || Date.now(),
			updatedAt: Date.now()
		};
		await redis.set(`${CODE_PREFIX}${itemId}`, code);
		await saveItem(itemId, item);
		res.json({ success: true, data: item });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.post("/api/market/import-github", requireAdmin, async (req, res) => {
	const { owner, repo, path: dirPath, branch, defaultPrice, category } = req.body;
	if (!owner || !repo || !dirPath || typeof defaultPrice !== "number" || defaultPrice < 0) {
		return res.status(400).json({ success: false, error: "owner, repo, path et defaultPrice (nombre) sont requis" });
	}
	try {
		const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}${branch ? `?ref=${branch}` : ""}`;
		const ghRes = await fetch(apiUrl, {
			headers: {
				"User-Agent": "hedgehog-market",
				"Accept": "application/vnd.github+json"
			}
		});
		if (!ghRes.ok) {
			return res.status(502).json({ success: false, error: `GitHub a répondu HTTP ${ghRes.status}` });
		}
		const entries = await ghRes.json();
		if (!Array.isArray(entries)) {
			return res.status(502).json({ success: false, error: "Réponse GitHub inattendue (le chemin est-il un dossier ?)" });
		}

		const files = entries.filter(e => e.type === "file" && e.name.endsWith(".js"));
		const added = [];
		const skipped = [];

		for (const file of files) {
			const itemId = file.name.replace(/\.js$/, "");
			const existing = await getItem(itemId);
			if (existing) {
				skipped.push(file.name);
				continue;
			}
			const item = {
				itemId,
				name: file.name,
				description: `Importé depuis ${owner}/${repo}/${dirPath}`,
				price: defaultPrice,
				category: category || "goatbot",
				source: "github",
				ref: file.download_url,
				sales: 0,
				createdAt: Date.now(),
				updatedAt: Date.now()
			};
			await saveItem(itemId, item);
			added.push(file.name);
		}

		res.json({ success: true, data: { total: files.length, added, skipped } });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.put("/api/market/items/:itemId", requireAdmin, async (req, res) => {
	try {
		const existing = await getItem(req.params.itemId);
		if (!existing) return res.status(404).json({ success: false, error: "Item introuvable" });
		const updated = { ...existing, ...req.body, itemId: req.params.itemId, updatedAt: Date.now() };
		await saveItem(req.params.itemId, updated);
		res.json({ success: true, data: updated });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.delete("/api/market/items/:itemId", requireAdmin, async (req, res) => {
	try {
		await redis.del(`${ITEM_PREFIX}${req.params.itemId}`);
		res.json({ success: true, data: { itemId: req.params.itemId, deleted: true } });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.post("/api/market/purchase", async (req, res) => {
	const { userId, itemId, userName } = req.body;
	if (!userId || !itemId) {
		return res.status(400).json({ success: false, error: "userId et itemId sont requis" });
	}
	try {
		const item = await getItem(itemId);
		if (!item) return res.status(404).json({ success: false, error: "Item introuvable" });

		const owned = await getOwned(userId);
		const already = owned.find(o => o.itemId === itemId);
		const rawUrl = `${req.protocol}://${req.get("host")}/raw/${itemId}`;

		if (already) {
			return res.json({ success: true, data: { alreadyOwned: true, itemId, rawUrl } });
		}

		owned.push({ itemId, name: item.name, purchasedAt: Date.now(), pricePaid: item.price, buyerName: userName || "User" });
		await saveOwned(userId, owned);

		item.sales = (item.sales || 0) + 1;
		await saveItem(itemId, item);

		res.json({
			success: true,
			data: { alreadyOwned: false, userId, itemId, name: item.name, pricePaid: item.price, rawUrl }
		});
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/market/owns/:userId/:itemId", async (req, res) => {
	try {
		const owned = await getOwned(req.params.userId);
		const has = owned.some(o => o.itemId === req.params.itemId);
		res.json({ success: true, data: { owns: has } });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/api/market/inventory/:userId", async (req, res) => {
	try {
		const owned = await getOwned(req.params.userId);
		res.json({ success: true, data: { userId: req.params.userId, items: owned } });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.get("/raw/:itemId", async (req, res) => {
	try {
		const item = await getItem(req.params.itemId);
		if (!item) return res.status(404).send("Item introuvable");

		if (item.source === "inline") {
			const code = await redis.get(`${CODE_PREFIX}${req.params.itemId}`);
			if (!code) return res.status(404).send("Code introuvable");
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			return res.send(code);
		}

		if (item.source === "github") {
			const ghRes = await fetch(item.ref, { headers: BROWSER_HEADERS });
			if (!ghRes.ok) {
				return res.status(502).send(`Impossible de récupérer le contenu depuis GitHub (HTTP ${ghRes.status})`);
			}
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			return res.send(await ghRes.text());
		}

		const pastebinId = item.ref || req.params.itemId;
		const result = await fetchPastebinRaw(pastebinId);
		if (!result.ok) {
			return res.status(502).send(`Impossible de récupérer le contenu depuis Pastebin (HTTP ${result.status || "inconnu"})`);
		}

		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.send(result.text);
	} catch (error) {
		res.status(500).send("Erreur serveur: " + error.message);
	}
});

app.use((req, res) => {
	res.status(404).json({ success: false, error: "Route not found" });
});

module.exports = app;
