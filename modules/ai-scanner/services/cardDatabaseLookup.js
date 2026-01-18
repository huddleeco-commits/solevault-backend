/**
 * Card Database Lookup Service
 * Searches for sneaker/collectible information from external databases
 * Returns mock data for development
 */

// Mock sneaker database
const MOCK_SNEAKERS = [
  {
    id: 'nike-air-jordan-1-chicago',
    brand: 'Nike',
    model: 'Air Jordan 1 Retro High OG',
    colorway: 'Chicago',
    sku: '555088-101',
    releaseDate: '2015-05-30',
    retailPrice: 160,
    marketPrice: 2500,
    category: 'basketball',
    silhouette: 'Air Jordan 1'
  },
  {
    id: 'nike-dunk-low-panda',
    brand: 'Nike',
    model: 'Dunk Low',
    colorway: 'Black/White (Panda)',
    sku: 'DD1391-100',
    releaseDate: '2021-03-10',
    retailPrice: 110,
    marketPrice: 150,
    category: 'lifestyle',
    silhouette: 'Dunk'
  },
  {
    id: 'adidas-yeezy-350-zebra',
    brand: 'Adidas',
    model: 'Yeezy Boost 350 V2',
    colorway: 'Zebra',
    sku: 'CP9654',
    releaseDate: '2017-02-25',
    retailPrice: 220,
    marketPrice: 350,
    category: 'lifestyle',
    silhouette: 'Yeezy 350'
  },
  {
    id: 'new-balance-550-white-green',
    brand: 'New Balance',
    model: '550',
    colorway: 'White Green',
    sku: 'BB550WT1',
    releaseDate: '2021-02-01',
    retailPrice: 120,
    marketPrice: 180,
    category: 'lifestyle',
    silhouette: '550'
  }
];

// Search for sneaker by various criteria
async function lookupCardInDatabase(searchCriteria) {
  const { brand, model, sku, colorway, query } = searchCriteria;

  console.log('🔍 Card DB Lookup:', searchCriteria);

  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 100));

  let results = [...MOCK_SNEAKERS];

  // Filter by brand
  if (brand) {
    results = results.filter(s =>
      s.brand.toLowerCase().includes(brand.toLowerCase())
    );
  }

  // Filter by model
  if (model) {
    results = results.filter(s =>
      s.model.toLowerCase().includes(model.toLowerCase())
    );
  }

  // Filter by SKU
  if (sku) {
    results = results.filter(s =>
      s.sku.toLowerCase().includes(sku.toLowerCase())
    );
  }

  // Filter by colorway
  if (colorway) {
    results = results.filter(s =>
      s.colorway.toLowerCase().includes(colorway.toLowerCase())
    );
  }

  // General query search
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(s =>
      s.brand.toLowerCase().includes(q) ||
      s.model.toLowerCase().includes(q) ||
      s.colorway.toLowerCase().includes(q) ||
      s.sku.toLowerCase().includes(q)
    );
  }

  return {
    success: true,
    count: results.length,
    results: results.map(sneaker => ({
      ...sneaker,
      confidence: 0.85 + Math.random() * 0.15, // Mock confidence score
      source: 'mock_database'
    }))
  };
}

// Get sneaker by ID
async function getCardById(id) {
  const sneaker = MOCK_SNEAKERS.find(s => s.id === id);

  if (!sneaker) {
    return { success: false, error: 'Sneaker not found' };
  }

  return {
    success: true,
    data: {
      ...sneaker,
      priceHistory: generateMockPriceHistory(),
      sizeChart: generateMockSizeChart()
    }
  };
}

// Get market price estimate
async function getMarketPrice(brand, model, size = null) {
  console.log('💰 Getting market price for:', { brand, model, size });

  const sneaker = MOCK_SNEAKERS.find(s =>
    s.brand.toLowerCase() === brand.toLowerCase() &&
    s.model.toLowerCase().includes(model.toLowerCase())
  );

  const basePrice = sneaker?.marketPrice || 150;
  const sizeMultiplier = size && (size < 8 || size > 12) ? 1.2 : 1;

  return {
    success: true,
    estimatedPrice: Math.round(basePrice * sizeMultiplier),
    priceRange: {
      low: Math.round(basePrice * 0.85),
      high: Math.round(basePrice * 1.25)
    },
    lastUpdated: new Date().toISOString()
  };
}

// Helper functions
function generateMockPriceHistory() {
  const history = [];
  const now = Date.now();
  for (let i = 30; i >= 0; i--) {
    history.push({
      date: new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      price: 150 + Math.random() * 100
    });
  }
  return history;
}

function generateMockSizeChart() {
  return {
    '7': { available: true, price: 180 },
    '8': { available: true, price: 160 },
    '9': { available: true, price: 150 },
    '10': { available: true, price: 150 },
    '11': { available: true, price: 155 },
    '12': { available: false, price: 170 },
    '13': { available: true, price: 190 }
  };
}

module.exports = {
  lookupCardInDatabase,
  getCardById,
  getMarketPrice
};
