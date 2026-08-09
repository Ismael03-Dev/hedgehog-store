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
const ADMIN_KEY = process.env.HEDGEHOG_ADMIN_KEY;

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
		res.json({ success: true, data: item });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.post("/api/market/items", requireAdmin, async (req, res) => {
	const { itemId, name, description, price, category } = req.body;
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

		const result = await fetchPastebinRaw(req.params.itemId);
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
