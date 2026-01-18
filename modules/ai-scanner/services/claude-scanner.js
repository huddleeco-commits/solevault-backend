const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

class ClaudeScanner {
    constructor() {
        this.client = new Anthropic({
            apiKey: process.env.CLAUDE_API_KEY
        });
    }

    async processImage(base64Image) {
        try {
            if (!base64Image) return null;

            console.log('Processing image: auto-rotate and optimize...');
            
            // Remove data URL prefix if present
            const base64Data = base64Image.includes('base64,') 
                ? base64Image.split('base64,')[1] 
                : base64Image;
            
            const buffer = Buffer.from(base64Data, 'base64');
            
            // Process with sharp: auto-orient, resize, optimize (Safari-compatible sizing)
            const processedBuffer = await sharp(buffer)
                .rotate() // Auto-rotate based on EXIF orientation
                .resize(800, 1120, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({ 
                    quality: 85,
                    mozjpeg: true 
                })
                .toBuffer();
            
            console.log(`Image processed: ${buffer.length} -> ${processedBuffer.length} bytes`);
            
            // Convert back to base64 with data URL prefix
            return `data:image/jpeg;base64,${processedBuffer.toString('base64')}`;
        } catch (error) {
            console.error('Image processing error:', error);
            // Return original if processing fails
            return base64Image;
        }
    }

    async scanCard(frontImageBase64, backImageBase64 = null, setIntelligence = null) {
        try {
            if (setIntelligence) {
                console.log(`🎯 Starting Claude Vision card scan with set intelligence: ${setIntelligence.set_full_name}`);
            } else {
                console.log('Starting Claude Vision card scan...');
            }

            // Process images to fix orientation and optimize
            const processedFrontImage = await this.processImage(frontImageBase64);
            const processedBackImage = backImageBase64 
                ? await this.processImage(backImageBase64) 
                : null;

            const images = [
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: this.getMediaType(processedFrontImage),
                        data: this.cleanBase64(processedFrontImage)
                    }
                }
            ];

            // Add back image if provided
            if (processedBackImage) {
                images.push({
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: this.getMediaType(processedBackImage),
                        data: this.cleanBase64(processedBackImage)
                    }
                });
            }

            const prompt = this.buildPrompt(setIntelligence);

            const message = await this.client.messages.create({
                model: "claude-sonnet-4-5-20250929",
                max_tokens: 1024,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: prompt
                            },
                            ...images
                        ]
                    }
                ]
            });

            console.log('Claude response received');
            console.log('Token usage:', message.usage);

            const responseText = message.content[0].text;
            const cardData = this.parseResponse(responseText);

            console.log('Parsed card data:', cardData);

            // Calculate total tokens
            const totalTokens = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0);

            return {
    success: true,
    card: cardData,
    confidence: message.usage ? 'high' : 'medium',
    processedFrontImage: processedFrontImage,  // 🔥 RE-ENABLED
    processedBackImage: processedBackImage,    // 🔥 RE-ENABLED
    usage: {
        input_tokens: message.usage?.input_tokens || 0,
        output_tokens: message.usage?.output_tokens || 0,
        total_tokens: totalTokens
    }
};

        } catch (error) {
            console.error('Claude scan error:', error);
            return {
                success: false,
                error: error.message,
                card: this.getEmptyCard(),
                // Include empty usage for failed scans
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0
                }
            };
        }
    }

    buildPrompt(setIntelligence = null) {
        let setIntelligenceSection = '';
        
        if (setIntelligence && setIntelligence.parallels) {
            try {
                const parallels = typeof setIntelligence.parallels === 'string' 
                    ? JSON.parse(setIntelligence.parallels) 
                    : setIntelligence.parallels;
                
                const parallelNames = parallels.map(p => 
                    p.numbered && p.printRun ? `"${p.name}" (/${p.printRun})` : `"${p.name}"`
                ).join(', ');
                
                setIntelligenceSection = `
SET: ${setIntelligence.set_full_name}
Parallels: ${parallelNames}
`;
            } catch (error) {
                console.error('Failed to parse set intelligence parallels:', error);
            }
        }
        
        return `Extract card data from ALL images provided. Sports or Pokemon TCG.

IMAGES: If 2 images (front+back), use BOTH to detect parallels, serial numbers, and autographs.

${setIntelligenceSection}
COLOR (check card BORDER edge, ignore holographic reflections):
Green=grass/emerald, Red=fire truck, Pink=light red/magenta, Orange=pumpkin, Blue=sky/navy
WARNING: Green Prizm reflects pink - if border is green, parallel is GREEN not Pink.

PARALLEL NAMING (use SportsCardsPro format):
- Use color only, NOT "Color Prizm": Orange, Green, Red, Blue, Pink, Silver, Gold (NOT "Orange Prizm")
- Use color only, NOT "Color Refractor": Blue, Green, Pink, Orange, Red (NOT "Blue Refractor")
- Exception: "Mojo" not "Mojo Refractor", "Refractor" for base chrome cards
- For Mosaic: use "Mosaic" not "Mosaic Prizm"
- For Select tiers: Concourse/Mezzanine/Premier are TIERS not parallels - use the color (Silver, Blue, etc.)
- Inserts are NOT parallels: Game Ticket, Fireworks, Kaboom, Downtown = set parallel to "Base"

CRITICAL:
- Graded? Extract company/grade/cert
- Auto? Set is_autographed=true
- Serial (15/99)? Extract both numbers, set numbered="true"
- Parallel? Name only (no player/number)
- Check BACK image for serial numbers and parallel text

JSON only:
{
  "player": "Name",
  "year": 2024,
  "set_name": "Set (no year)",
  "card_number": "# or 025/165",
  "parallel": "Base or variant",
  "is_autographed": true/false,
  "numbered": "true"/"false",
  "serial_number": "15",
  "numbered_to": "99",
  "team": "Team",
  "sport": "Football/Basketball/Baseball/Hockey/Pokemon",
  "condition": "Mint/Near Mint/etc",
  "is_graded": true/false,
  "grading_company": "PSA/BGS/SGC/CGC",
  "grade": "10",
  "cert_number": "12345678",
  "ebay_search_string": "Optimized query"
}`;
    }

    parseResponse(responseText) {
        try {
            // Remove markdown code blocks if present
            let cleaned = responseText.trim();
            if (cleaned.startsWith('```json')) {
                cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            }
            if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/```\n?/g, '');
            }

            const parsed = JSON.parse(cleaned);

            // Set condition based on grade if graded
            let condition = parsed.condition || 'Near Mint';
            if (parsed.is_graded && parsed.grade) {
                const numericGrade = parseFloat(parsed.grade);
                if (numericGrade >= 9.5 || parsed.grade === '10') {
                    condition = 'Gem Mint';
                } else if (numericGrade >= 9) {
                    condition = 'Mint';
                } else if (numericGrade >= 8) {
                    condition = 'Near Mint';
                } else if (numericGrade >= 7) {
                    condition = 'Excellent';
                } else if (numericGrade >= 6) {
                    condition = 'Very Good';
                } else if (numericGrade >= 5) {
                    condition = 'Good';
                } else {
                    condition = 'Poor';
                }
            }

            // Helper: Clean parallel names (remove player names and card numbers)
            const cleanParallelName = (parallelString) => {
                if (!parallelString) return 'Base';
                
                let cleaned = parallelString;
                
                console.log('🧹 Cleaning parallel:', cleaned);
                
                // STEP 1: Extract ONLY text inside brackets if brackets exist
                // "Ja Morant [Green Shock] #190" → "Green Shock"
                if (cleaned.includes('[') && cleaned.includes(']')) {
                    const bracketMatch = cleaned.match(/\[([^\]]+)\]/);
                    if (bracketMatch && bracketMatch[1]) {
                        cleaned = bracketMatch[1].trim();
                        console.log('✅ Extracted from brackets:', cleaned);
                        return cleaned;
                    }
                }
                
                // STEP 2: Remove card numbers (e.g., #190, #5)
                cleaned = cleaned.replace(/#\d+/g, '').trim();
                
                // STEP 3: If no brackets, try to extract parallel name from common patterns
                // Pattern: "PlayerName ParallelName" → keep only last 1-3 words
                const words = cleaned.split(/\s+/);
                
                // If 3+ words and first word looks like a name, remove it
                if (words.length >= 3) {
                    // Common parallel keywords
                    const parallelKeywords = ['prizm', 'shock', 'wave', 'refractor', 'holo', 'shimmer', 'mosaic', 'disco', 'cracked', 'ice', 'scope', 'choice', 'silver', 'gold', 'red', 'blue', 'green', 'orange', 'purple', 'pink', 'black', 'white', 'neon', 'tiger', 'stripe'];
                    
                    // Find first word that matches a parallel keyword
                    let parallelStartIndex = words.findIndex(word => 
                        parallelKeywords.some(keyword => word.toLowerCase().includes(keyword))
                    );
                    
                    if (parallelStartIndex > 0) {
                        // Found parallel keyword - keep from there to end
                        cleaned = words.slice(parallelStartIndex).join(' ');
                        console.log('✅ Extracted parallel by keyword:', cleaned);
                        return cleaned;
                    }
                    
                    // Fallback: Just remove first word (likely player name)
                    cleaned = words.slice(1).join(' ');
                    console.log('✅ Removed first word:', cleaned);
                    return cleaned;
                }
                
                console.log('✅ Final cleaned parallel:', cleaned);
                return cleaned || 'Base';
            };

            // Ensure all required fields exist with defaults
            return {
                player: parsed.player || '',
                year: parsed.year || new Date().getFullYear(),
                set_name: parsed.set_name || '',
                card_number: parsed.card_number || '',
                parallel: cleanParallelName(parsed.parallel),
                visualColors: Array.isArray(parsed.visualColors) ? parsed.visualColors : [],
                patternType: parsed.patternType || null,
                parallelTextOnCard: parsed.parallelTextOnCard || null,
                is_autographed: parsed.is_autographed === true || parsed.is_autographed === 'true',
                numbered: parsed.numbered === true || parsed.numbered === 'true' ? 'true' : 'false',
                serial_number: parsed.serial_number || null,
                numbered_to: parsed.numbered_to || null,
                team: parsed.team || '',
                sport: parsed.sport || 'Football',
                condition: condition,
                is_graded: parsed.is_graded === true || parsed.is_graded === 'true',
                grading_company: parsed.grading_company || null,
                grade: parsed.grade || null,
                cert_number: parsed.cert_number || null,
                ebay_search_string: parsed.ebay_search_string || this.buildDefaultSearchString(parsed)
            };

        } catch (error) {
            console.error('Failed to parse Claude response:', error);
            console.error('Raw response:', responseText);
            return this.getEmptyCard();
        }
    }

    buildDefaultSearchString(cardData) {
        let searchString = '';
        
        // Check if year is already in set_name
        const hasYearInSet = cardData.set_name && (
            /^\d{4}\s+/.test(cardData.set_name) || 
            cardData.set_name.includes(String(cardData.year))
        );
        
        // Basic info
        if (cardData.year && !hasYearInSet) searchString += `${cardData.year} `;
        if (cardData.set_name) searchString += `${cardData.set_name} `;
        if (cardData.player) searchString += `${cardData.player} `;
        if (cardData.card_number) searchString += `#${cardData.card_number} `;
        
        // CRITICAL: Handle parallels, numbered cards, and autos (raw cards)
        if (!cardData.is_graded) {
            // For numbered cards, ALWAYS include /XX format (highest priority)
            if (cardData.numbered === 'true' && cardData.numbered_to) {
                searchString += `/${cardData.numbered_to} `;
            }
            
            // For parallels, include the parallel name (also critical)
            if (cardData.parallel && cardData.parallel !== 'Base') {
                searchString += `${cardData.parallel} `;
            }
            
            // AUTOGRAPHS - CRITICAL for pricing
            if (cardData.is_autographed) {
                searchString += `Auto `;
            }
        }
        
        // For graded cards, include grade info
        if (cardData.is_graded) {
            if (cardData.grading_company) searchString += `${cardData.grading_company} `;
            if (cardData.grade) searchString += `${cardData.grade} `;
            
            // Graded autos still need "Auto" keyword
            if (cardData.is_autographed) {
                searchString += `Auto `;
            }
        }
        
        // Team (optional, less important)
        if (cardData.team) searchString += `${cardData.team}`;
        
        return searchString.trim();
    }

    getEmptyCard() {
        return {
            player: '',
            year: new Date().getFullYear(),
            set_name: '',
            card_number: '',
            parallel: 'Base',
            visualColors: [],
            patternType: null,
            parallelTextOnCard: null,
            is_autographed: false,
            numbered: 'false',
            serial_number: null,
            numbered_to: null,
            team: '',
            sport: 'Football',
            condition: 'Near Mint',
            is_graded: false,
            grading_company: null,
            grade: null,
            cert_number: null,
            ebay_search_string: ''
        };
    }

    cleanBase64(base64String) {
        // Remove data URL prefix if present
        if (base64String.includes('base64,')) {
            return base64String.split('base64,')[1];
        }
        return base64String;
    }

    getMediaType(base64String) {
        // Detect media type from base64 string
        if (base64String.includes('data:image/png')) return 'image/png';
        if (base64String.includes('data:image/jpeg')) return 'image/jpeg';
        if (base64String.includes('data:image/jpg')) return 'image/jpeg';
        if (base64String.includes('data:image/webp')) return 'image/webp';
        if (base64String.includes('data:image/gif')) return 'image/gif';
        
        // Default to jpeg
        return 'image/jpeg';
    }

    /**
     * Analyze image with multiple PSA/BGS slabs
     * Detects cert numbers, grades, and card details from labels
     */
    async analyzeMultipleSlabs(base64Image) {
    try {
        // 🔥 COMPRESS IMAGE FIRST (reuse existing processImage method)
        console.log('📸 Compressing multi-slab image...');
        const compressedImage = await this.processImage(base64Image);
        console.log('✅ Image compressed for multi-slab analysis');
        
        const prompt = `You are analyzing a photo containing MULTIPLE PSA or BGS graded card slabs.

YOUR TASK:
1. Detect ALL visible slabs in the image
2. For EACH slab, extract:
   - Cert/Serial number (from PSA/BGS label)
   - Player name
   - Year
   - Set name
   - Card number
   - Grading company (PSA/BGS/SGC)
   - Grade (e.g., "10", "9.5")
   - Sport

IMPORTANT:
- Look for PSA red labels or BGS black labels
- Cert numbers are usually 8-9 digits
- Extract ALL slabs you can see, even partially visible ones
- If you can't read something, mark it as null

Return JSON array with this EXACT structure:
{
  "cards": [
    {
      "player": "Patrick Mahomes",
      "year": 2017,
      "set_name": "Panini Prizm",
      "card_number": "127",
      "parallel": "Base",
      "sport": "Football",
      "grading_company": "PSA",
      "grade": "10",
      "cert_number": "12345678",
      "ebay_search_string": "2017 Panini Prizm Patrick Mahomes 127 PSA 10"
    }
  ]
}

Be thorough - find EVERY slab in the image!`;

        const message = await this.client.messages.create({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 4096,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: this.getMediaType(compressedImage),
                                data: this.cleanBase64(compressedImage)
                            }
                        },
                        {
                            type: "text",
                            text: prompt
                        }
                    ]
                }
            ]
        });

        const textContent = message.content.find(c => c.type === 'text');
        if (!textContent) {
            return {
                success: false,
                error: 'No response from AI'
            };
        }

        // Extract JSON from response
        let jsonText = textContent.text;
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            jsonText = jsonMatch[0];
        }

        const result = JSON.parse(jsonText);

        console.log(`🎯 Detected ${result.cards?.length || 0} slabs`);

        return {
            success: true,
            cards: result.cards || [],
            usage: message.usage
        };

    } catch (error) {
        console.error('Multi-slab analysis error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
     * PASS 1: Detect slab positions in image
     */
    async detectSlabPositions(base64Image) {
        try {
            console.log('📸 Compressing image for position detection...');
            const compressedImage = await this.processImage(base64Image);
            
            const prompt = `You are detecting PSA, BGS, and SGC graded card slabs in a photo.

YOUR TASK:
1. Identify the POSITION and LOCATION of each slab
2. For each slab, provide approximate bounding box (x, y, width, height as percentages 0-100)

Return JSON:
{
  "slabs": [
    {
      "boundingBox": {"x": 10, "y": 15, "width": 20, "height": 30},
      "gradingCompany": "PSA"
    }
  ]
}`;

            const message = await this.client.messages.create({
                model: "claude-sonnet-4-5-20250929",
                max_tokens: 2048,
                messages: [{
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: this.getMediaType(compressedImage), data: this.cleanBase64(compressedImage) }},
                        { type: "text", text: prompt }
                    ]
                }]
            });

            const textContent = message.content.find(c => c.type === 'text');
            if (!textContent) return { success: false, error: 'No response' };

            let jsonText = textContent.text;
            const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
            if (jsonMatch) jsonText = jsonMatch[0];

            const result = JSON.parse(jsonText);
            const positions = (result.slabs || []).map(slab => ({
                boundingBox: slab.boundingBox,
                cardInfo: { grading_company: slab.gradingCompany }
            }));

            console.log(`🎯 Detected ${positions.length} slab positions`);
            return { success: true, positions };
        } catch (error) {
            console.error('Position detection error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * PASS 2: Analyze single cropped slab
     */
    async analyzeSingleSlab(croppedBase64Image) {
        try {
            const prompt = `Analyze this SINGLE graded slab. Extract cert number with high accuracy.

GRADING COMPANIES:
- PSA: Red/blue labels
- BGS: Black labels  
- SGC: Black/gray labels

CRITICAL: If image is too blurry/dark to read, still return JSON with null values.
NEVER apologize or explain - ALWAYS return valid JSON.

Return ONLY this JSON structure (no other text):
{
  "player": "Player name or null",
  "year": 2024,
  "set_name": "Set name or null",
  "card_number": "Card # or null",
  "parallel": "Base",
  "sport": "Football or null",
  "grading_company": "PSA or null",
  "grade": "10 or null",
  "cert_number": "12345678 or null",
  "ebay_search_string": "2024 Set Player PSA 10 or empty"
}

If you cannot read the cert number clearly, set cert_number to null.
RETURN ONLY THE JSON. NO APOLOGIES. NO EXPLANATIONS.`;

            const message = await this.client.messages.create({
                model: "claude-sonnet-4-5-20250929",
                max_tokens: 1024,
                messages: [{
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: this.getMediaType(croppedBase64Image), data: this.cleanBase64(croppedBase64Image) }},
                        { type: "text", text: prompt }
                    ]
                }]
            });

            const textContent = message.content.find(c => c.type === 'text');
            if (!textContent) return { success: false, error: 'No response' };

            let jsonText = textContent.text;
            
            // Strip markdown and explanations
            jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            
            // Extract JSON from response
            const jsonMatch = jsonText.match(/\{[\s\S]*?\}/);
            if (!jsonMatch) {
                console.log('⚠️  No JSON found in response:', jsonText.substring(0, 100));
                return {
                    success: false,
                    error: 'Unable to read - image quality too low'
                };
            }
            
            jsonText = jsonMatch[0];
            const card = JSON.parse(jsonText);
            return {
                success: true,
                card: {
                    player: card.player || '',
                    year: card.year || new Date().getFullYear(),
                    set_name: card.set_name || '',
                    card_number: card.card_number || '',
                    parallel: card.parallel || 'Base',
                    sport: card.sport || 'Football',
                    grading_company: card.grading_company || null,
                    grade: card.grade || null,
                    cert_number: card.cert_number || null,
                    ebay_search_string: card.ebay_search_string || ''
                }
            };
        } catch (error) {
            console.error('Single slab error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Extract cert number from cropped slab image
     * Laser-focused on cert number accuracy - nothing else matters
     */
    async extractCertNumber(croppedBase64Image) {
        try {
            const prompt = `Extract the CERTIFICATION NUMBER from this graded card slab.

GRADING COMPANIES:
- PSA: Red/blue labels, cert on front label (usually 8-9 digits)
- BGS: Black labels, cert on back label (usually 7-9 digits)
- SGC: Black/gray labels, cert on label (usually 7-9 digits)

YOUR ONLY JOB: Find the cert number with 100% accuracy.

CRITICAL RULES:
1. If cert number is clearly visible, extract it EXACTLY as shown
2. If cert number is partially visible, extract what you can see
3. If cert number is not visible/readable, return null
4. NEVER guess or make up cert numbers
5. ALWAYS return valid JSON (no apologies, no explanations)

Return ONLY this JSON (no other text):
{
  "cert_number": "12345678 or null",
  "grading_company": "PSA or null",
  "grade": "10 or null",
  "player": "Player name or null",
  "year": 2024,
  "set_name": "Set name or null",
  "sport": "Football or null"
}

REMEMBER: Cert number accuracy is CRITICAL. If unsure, return null.
NO APOLOGIES. NO EXPLANATIONS. ONLY JSON.`;

            const message = await this.client.messages.create({
                model: "claude-sonnet-4-5-20250929",
                max_tokens: 512,
                messages: [{
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: this.getMediaType(croppedBase64Image), data: this.cleanBase64(croppedBase64Image) }},
                        { type: "text", text: prompt }
                    ]
                }]
            });

            const textContent = message.content.find(c => c.type === 'text');
            if (!textContent) {
                return { success: false, error: 'No response from AI' };
            }

            let jsonText = textContent.text;
            jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            
            const jsonMatch = jsonText.match(/\{[\s\S]*?\}/);
            if (!jsonMatch) {
                console.log('⚠️  No JSON in response:', jsonText.substring(0, 100));
                return { success: false, error: 'Unable to read cert number - image quality too low' };
            }
            
            const result = JSON.parse(jsonMatch[0]);

            if (result.cert_number && result.cert_number !== 'null') {
                const cleanedCert = result.cert_number.replace(/[^0-9\s-]/g, '');
                if (cleanedCert.length < 6 || cleanedCert.length > 12) {
                    console.log(`⚠️  Suspicious cert number: ${result.cert_number}`);
                }
            }

            return {
                success: true,
                cert_number: result.cert_number === 'null' ? null : result.cert_number,
                grading_company: result.grading_company === 'null' ? null : result.grading_company,
                grade: result.grade === 'null' ? null : result.grade,
                player: result.player === 'null' ? null : result.player,
                year: result.year || new Date().getFullYear(),
                set_name: result.set_name === 'null' ? null : result.set_name,
                sport: result.sport === 'null' ? null : result.sport
            };

        } catch (error) {
            console.error('Cert extraction error:', error);
            return { success: false, error: error.message || 'Failed to extract cert number' };
        }
    }

}

module.exports = new ClaudeScanner();