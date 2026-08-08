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
const COUNTER_KEY = "market:next_id";
const ADMIN_KEY = "hedgehog-store-2026";

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

// Prix stockés en string décimale (comme l'API cash) pour supporter des montants énormes sans perte de précision
function isValidAmountString(str) {
	return typeof str === "string" && /^\d+$/.test(str);
}

async function getNextId() {
	const next = await redis.incr(COUNTER_KEY);
	return String(next);
}

async function getItem(id) {
	const raw = await redis.get(`${ITEM_PREFIX}${id}`);
	if (!raw) return null;
	return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function saveItem(id, data) {
	await redis.set(`${ITEM_PREFIX}${id}`, JSON.stringify(data));
}

async function getAllItems() {
	const keys = await redis.keys(`${ITEM_PREFIX}*`);
	const items = [];
	for (const key of keys) {
		const raw = await redis.get(key);
		const item = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (item) items.push(item);
	}
	// tri numérique par id (1, 2, 3... et pas "1", "10", "2")
	return items.sort((a, b) => Number(a.id) - Number(b.id));
}

async function getOwned(userId) {
	const raw = await redis.get(`${OWNED_PREFIX}${userId}`);
	if (!raw) return [];
	return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function saveOwned(userId, list) {
	await redis.set(`${OWNED_PREFIX}${userId}`, JSON.stringify(list));
}

app.get("/", (req, res) => {
	res.json({
		message: "Hedgehog Market API opérationnelle",
		version: "2.0",
		endpoints: {
			"GET /api/market/items": "Liste tous les items en vente",
			"GET /api/market/items/:id": "Détail d'un item (id court, ex: 3)",
			"POST /api/market/items": "Ajouter un item (admin, header x-admin-key) { pastebinId, name, description, price }",
			"PUT /api/market/items/:id": "Modifier un item (admin)",
			"DELETE /api/market/items/:id": "Supprimer un item (admin)",
			"POST /api/market/purchase": "Enregistrer un achat { userId, itemId, userName }",
			"GET /api/market/owns/:userId/:itemId": "Vérifie si un user possède un item",
			"GET /api/market/inventory/:userId": "Liste les items possédés par un user",
			"GET /raw/:id": "Contenu brut de la commande (proxy Pastebin, id court)"
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

app.get("/api/market/items/:id", async (req, res) => {
	try {
		const item = await getItem(req.params.id);
		if (!item) return res.status(404).json({ success: false, error: "Item introuvable" });
		res.json({ success: true, data: item });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.post("/api/market/items", requireAdmin, async (req, res) => {
	const { pastebinId, name, description, price, category } = req.body;
	const priceStr = String(price);

	if (!pastebinId || !name || !isValidAmountString(priceStr)) {
		return res.status(400).json({
			success: false,
			error: "pastebinId, name et price (chaîne de chiffres, ex: '100000') sont requis"
		});
	}

	try {
		const id = await getNextId();
		const item = {
			id,
			pastebinId,
			name,
			description: description || "",
			price: priceStr,
			category: category || "goatbot",
			createdAt: Date.now(),
			updatedAt: Date.now()
		};
		await saveItem(id, item);
		res.json({ success: true, data: item });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.put("/api/market/items/:id", requireAdmin, async (req, res) => {
	try {
		const existing = await getItem(req.params.id);
		if (!existing) return res.status(404).json({ success: false, error: "Item introuvable" });

		const updates = { ...req.body };
		if (updates.price !== undefined) {
			const priceStr = String(updates.price);
			if (!isValidAmountString(priceStr)) {
				return res.status(400).json({ success: false, error: "price doit être une chaîne de chiffres" });
			}
			updates.price = priceStr;
		}

		const updated = { ...existing, ...updates, id: req.params.id, updatedAt: Date.now() };
		await saveItem(req.params.id, updated);
		res.json({ success: true, data: updated });
	} catch (error) {
		res.status(500).json({ success: false, error: error.message });
	}
});

app.delete("/api/market/items/:id", requireAdmin, async (req, res) => {
	try {
		await redis.del(`${ITEM_PREFIX}${req.params.id}`);
		res.json({ success: true, data: { id: req.params.id, deleted: true } });
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

app.get("/raw/:id", async (req, res) => {
	try {
		const item = await getItem(req.params.id);
		if (!item) return res.status(404).send("Item introuvable");

		const pastebinRaw = `https://pastebin.com/raw/${item.pastebinId}`;
		const response = await fetch(pastebinRaw);
		if (!response.ok) return res.status(502).send("Impossible de récupérer le contenu depuis Pastebin");

		const text = await response.text();
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.send(text);
	} catch (error) {
		res.status(500).send("Erreur serveur: " + error.message);
	}
});

app.use((req, res) => {
	res.status(404).json({ success: false, error: "Route not found" });
});

module.exports = app;
