const express = require('express');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const https = require('https');
const fs = require('fs'); // Dodano, ako je potrebno za certifikate ili slično, inače se može ukloniti
require('dotenv').config();

// Azure SDK Imports
const { BlobServiceClient } = require('@azure/storage-blob');
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai"); // ISPRAVLJENO: Vraćeno na OpenAIClient
// Uklonjen je import za AzureKeyCredential iz @azure/core-auth jer je sada dio @azure/openai za ovu verziju

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// Azure Cognitive Search Configuration
const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
const searchIndexName = process.env.AZURE_SEARCH_INDEX;
const searchApiKey = process.env.AZURE_SEARCH_API_KEY;

// Azure Computer Vision Configuration (za OCR, ako ga planirate koristiti za indeksiranje)
const azureCvEndpoint = process.env.AZURE_CV_ENDPOINT;
const azureCvKey = process.env.AZURE_CV_KEY;

// Azure Blob Storage Configuration
const azureStorageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const azureStorageAccountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const azureStorageContainerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

// Azure OpenAI Service Configuration
const azureOpenAiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureOpenAiKey = process.env.AZURE_OPENAI_API_KEY;
const azureOpenAiDeploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;

// Provjera osnovnih varijabli okoline
if (!searchEndpoint || !searchIndexName || !searchApiKey || !azureStorageAccountName || !azureStorageAccountKey || !azureStorageContainerName) {
    console.error("Missing one or more required environment variables for Azure Search or Blob Storage.");
    console.error("Please ensure AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_INDEX, AZURE_SEARCH_API_KEY, AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY, AZURE_STORAGE_CONTAINER_NAME are set in your .env file.");
    process.exit(1); // Exit if critical variables are missing
}

if (!azureOpenAiEndpoint || !azureOpenAiKey || !azureOpenAiDeploymentName) {
    console.error("Missing one or more required environment variables for Azure OpenAI Service.");
    console.error("Please ensure AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT_NAME are set in your .env file.");
    process.exit(1); // Exit if critical variables are missing
}

const blobServiceClient = BlobServiceClient.fromConnectionString(
    `DefaultEndpointsProtocol=https;AccountName=${azureStorageAccountName};AccountKey=${azureStorageAccountKey};EndpointSuffix=core.windows.net`
);
const containerClient = blobServiceClient.getContainerClient(azureStorageContainerName);

// Inicijalizacija Azure OpenAI klijenta
const openaiClient = new OpenAIClient( // ISPRAVLJENO: Vraćeno na OpenAIClient
    azureOpenAiEndpoint,
    new AzureKeyCredential(azureOpenAiKey) // ISPRAVLJENO: Vraćeno na AzureKeyCredential objekt
);
console.log("Azure OpenAI Service client initialized.");

// HTTPS Agent for secure connections, especially important for Azure services
const httpsAgent = new https.Agent({
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: true,
});

/**
 * Performs OCR on an image using Azure Computer Vision.
 * Note: This function is present in your code but not directly used in the current /upload-image endpoint
 * for processing the uploaded image's text. If you want to OCR images on upload and then index that text,
 * you would need to integrate this function within your /upload-image or a separate processing step.
 * @param {Buffer} imageData - The image data as a Buffer.
 * @returns {Promise<string>} The extracted text from the image.
 */
async function ocrImageAzure(imageData) { // Promijenjen parametar iz imagePath u imageData (Buffer)
    try {
        if (!azureCvEndpoint || !azureCvKey) {
            console.warn("Azure Computer Vision configuration missing. OCR function will not work.");
            return "";
        }

        const url = `${azureCvEndpoint}/vision/v3.2/ocr?language=unk&detectOrientation=true`;

        const response = await axios.post(url, imageData, { // Koristi imageData (Buffer)
            headers: {
                'Ocp-Apim-Subscription-Key': azureCvKey,
                'Content-Type': 'application/octet-stream',
            },
            httpsAgent,
        });

        const regions = response.data.regions || [];
        let text = "";
        regions.forEach(region => {
            region.lines.forEach(line => {
                line.words.forEach(word => {
                    text += word.text + " ";
                });
                text += "\n";
            });
        });

        return text.trim();
    } catch (error) {
        console.error("OCR greška:", error.response?.data?.error?.message || error.message);
        return "";
    }
}

/**
 * Handles PDF file uploads to Azure Blob Storage.
 */
app.post('/upload-pdf', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Datoteka je obavezna" });
    }

    try {
        const blobName = `${Date.now()}-${req.file.originalname}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype }
        });

        res.json({
            message: "PDF uspješno prenesen na Azure Blob Storage.",
            blobUrl: blockBlobClient.url,
            fileName: blobName
        });

    } catch (error) {
        console.error("Greška pri prenosu PDF-a na Blob Storage:", error.response?.data?.error?.message || error.message);
        res.status(500).json({ error: "Greška pri prenosu PDF-a na Azure Blob Storage" });
    }
});

/**
 * Handles image file uploads to Azure Blob Storage.
 */
app.post('/upload-image', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "Slika je obavezna" });
    }

    try {
        const blobName = `${Date.now()}-${req.file.originalname}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype }
        });

        // Ovdje možete dodati poziv OCR-a ako želite odmah obraditi sliku i možda spremiti tekst
        // const ocrExtractedText = await ocrImageAzure(req.file.buffer);
        // console.log("Extracted text from image:", ocrExtractedText);
        // Dalje možete spremiti ocrExtractedText u bazu podataka ili drugi servis ako je potrebno.

        res.json({
            message: "Slika uspješno prenesena na Azure Blob Storage.",
            blobUrl: blockBlobClient.url,
            fileName: blobName
        });

    } catch (error) {
        console.error("Greška pri prenosu slike na Blob Storage:", error.response?.data?.error?.message || error.message);
        res.status(500).json({ error: "Greška pri prenosu slike na Azure Blob Storage" });
    }
});


/**
 * Fetches documents from Azure Cognitive Search based on a query.
 * @param {string} query - The search query.
 * @returns {Promise<Array<Object>>} An array of document hits.
 */
async function fetchFromAzureSearch(query) {
    try {
        const response = await axios.post(
            `${searchEndpoint}/indexes/${searchIndexName}/docs/search?api-version=2021-04-30-Preview`,
            {
                search: query,
                top: 7,
                // Ažurirano: Uklonjeni 'merged_content' i 'source' jer ih nema u vašem indeksu 'trio'
                select: "content, ocrText, extractedContent, metadata_storage_name, id"
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': searchApiKey,
                },
                httpsAgent,
            }
        );

        const hits = response.data.value;
        console.log("Azure Search Raw Hits (first 200 chars):", JSON.stringify(hits.map(h => ({
            // Ažurirano: Prilagođen odabir sadržaja i izvora
            contentPreview: (h.content || h.ocrText || h.extractedContent || "").substring(0, 200) + '...',
            source: h.metadata_storage_name || "Nepoznati izvor", // Koristi samo metadata_storage_name
            id: h.id || 'N/A'
        })), null, 2));

        return hits.map(hit => ({
            // Ažurirano: Sastavi cijeli sadržaj iz dostupnih polja
            content: (hit.content || "") + " " + (hit.ocrText || "") + " " + (hit.extractedContent || ""),
            source: hit.metadata_storage_name || "Nepoznati izvor" // Koristi samo metadata_storage_name
        }));
    } catch (err) {
        console.error("Azure Search greška u fetchFromAzureSearch:", err.response?.data?.error?.message || err.message);
        return [];
    }
}

/**
 * Filters relevant documents based on keywords from the query.
 * This helps refine the documents before building the context.
 * @param {string} query - The user's original query.
 * @param {Array<Object>} documents - Documents fetched from Azure Search.
 * @returns {Array<Object>} An array of filtered, relevant documents.
 */
function filterRelevantDocuments(query, documents) {
    const stopwords = new Set([
        "i", "u", "na", "za", "je", "su", "se", "to", "od", "da", "ne", "a", "koji", "što",
        "kao", "ali", "ili", "pa", "ako", "te", "će", "što" // Croatian stopwords
    ]);

    const queryWords = query
        .toLowerCase()
        .split(/\W+/) // Split by non-alphanumeric characters
        .filter(w => w.length > 2 && !stopwords.has(w));

    console.log("Query words for filtering:", queryWords);

    if (queryWords.length === 0) {
        // Ako nema značajnih riječi u upitu, vraćamo SVE dokumente koje je Azure Search pronašao.
        console.log("No significant query words for filtering. Returning all documents found by Azure Search.");
        return documents;
    }

    const filtered = documents.filter(doc => {
        const text = doc.content.toLowerCase();
        // Provjeri sadrži li dokument BAREM JEDNU od ključnih riječi iz upita
        return queryWords.some(kw => text.includes(kw));
    });

    console.log(`Filtered documents: ${filtered.length} out of ${documents.length}`);
    return filtered;
}

/**
 * Builds a contextual string from an array of documents,
 * truncating if necessary to stay within a maximum length.
 * @param {Array<Object>} documents - The relevant documents.
 * @param {number} maxLength - The maximum desired length of the context string.
 * @returns {string} The formatted context string.
 */
function buildContextFromDocuments(documents, maxLength = 15000) { // ISPRAVLJENO: Smanjen maxLength za token limite
    let context = "";
    for (const doc of documents) {
        const cleanContent = doc.content
            .replace(/\s+/g, " ") // Replace multiple spaces with a single space
            .trim();

        // Dodajte izvor dokumenta
        const segment = `Sadržaj dokumenta: "${doc.source}"\n${cleanContent}\n---\n`;

        if ((context.length + segment.length) > maxLength) {
            context += "... [sadržaj je skraćen zbog ograničenja duljine]\n";
            break;
        }
        context += segment;
    }
    if (context.trim() === "" && documents.length > 0) {
        return "Pronađeni su dokumenti, ali iz njih nije moguće izvući smislen odgovor.";
    }
    return context.trim();
}

/**
 * Handles chat requests by fetching relevant documents from Azure Cognitive Search
 * and then using Azure OpenAI Service to generate a response based on the context.
 */
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message?.trim();
        if (!userMessage) return res.status(400).json({ error: "Poruka je obavezna" });

        // 1. Fetch all potentially relevant documents from Azure Search
        console.log(`Searching Azure Search for query: "${userMessage}"`);
        const allDocuments = await fetchFromAzureSearch(userMessage);
        console.log(`Azure Search returned ${allDocuments.length} documents.`);

        // 2. Filter these documents to ensure higher relevance
        const relevantDocs = filterRelevantDocuments(userMessage, allDocuments);
        console.log(`After filtering, ${relevantDocs.length} documents are considered relevant.`);

        // 3. Build a consolidated context string from the filtered documents
        const context = buildContextFromDocuments(relevantDocs); // ISPRAVLJENO: Osigurano da je 'context' definiran

        let chatResponseMessage;

        if (!context || context.trim() === "" || context.includes("Pronađeni su dokumenti, ali iz njih nije moguće izvući smislen odgovor.")) {
            chatResponseMessage = "Na temelju dostupnih dokumenata, ne mogu pronaći odgovor na to pitanje.";
        } else {
            try {
                // Sastavljanje poruka za GPT model
                const messages = [
                    {
                        role: "system",
                        content: "Ti si chatbot koji pruža informacije isključivo na temelju konteksta koji ti je dostavljen. Ne izmišljaj informacije. Ako ne možeš pronaći odgovor u kontekstu, reci da ne znaš. Odgovaraj na hrvatskom jeziku."
                    },
                    {
                        role: "user",
                        content: `Evo konteksta iz dokumenata:\n\n${context}\n\n---\n\nPitanje korisnika: ${userMessage}\n\nMolim te, odgovori na pitanje korisnika isključivo na temelju dostavljenog konteksta. Ako je relevantno, navedi i izvor dokumenta (npr. [Izvor: NazivDokumenta.pdf]).`
                    }
                ];

                console.log("Sending to Azure OpenAI API (first 500 chars of user message content):", messages[1].content.substring(0, 500) + '...');

                // Poziv za Azure OpenAI Service
                const openaiResponse = await openaiClient.getChatCompletions(
                    azureOpenAiDeploymentName, // Naziv deployed modela iz .env
                    messages,
                    {
                        temperature: 0.7,
                        maxTokens: 1000 // Povećaj po potrebi, ali pazi na troškove i token limite modela
                    }
                );
                chatResponseMessage = openaiResponse.choices[0].message.content;

                console.log("Azure OpenAI Response:", chatResponseMessage);

            } catch (error) {
                console.error("Greška pri pozivu Azure OpenAI API-ja:", error.response?.data?.error?.message || error.message);
                // Dodana provjera za grešku prekoračenja duljine konteksta
                if (error.response?.data?.error?.code === "context_length_exceeded") {
                    chatResponseMessage = "Nažalost, odgovor je predugačak ili previše dokumenata je pronađeno da bi stalo u AI model. Molimo pokušajte preciznije pitanje.";
                } else {
                    chatResponseMessage = "Došlo je do greške prilikom generiranja odgovora pomoću AI-ja.";
                }
            }
        }

        res.json({
            response: chatResponseMessage,
            contextLength: context.length,
            documentsCount: relevantDocs.length,
            // Detaljniji prikaz za debugging
            debugInfo: {
                userQuery: userMessage,
                allDocumentsFoundBySearch: allDocuments.map(doc => ({
                    source: doc.source,
                    contentPreview: doc.content.substring(0, 200) + '...'
                })),
                relevantDocumentsUsed: relevantDocs.map(doc => ({
                    source: doc.source,
                    contentPreview: doc.content.substring(0, 200) + '...'
                })),
                contextBuilt: context.substring(0, 500) + (context.length > 500 ? '...' : '')
            }
        });
    } catch (error) {
        console.error("Chat greška u /chat endpointu:", error.message);
        res.status(500).json({ error: "Došlo je do greške na serveru" });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server pokrenut na http://localhost:${PORT}`);
});