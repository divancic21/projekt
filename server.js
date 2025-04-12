const express = require('express');
const axios = require('axios');
const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');
const https = require('https');
const pdf = require('pdf-parse');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 🔹 Postavljanje varijabli iz .env
const azureOpenAiKey = process.env.AZURE_OPENAI_KEY;
const azureOpenAiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureOpenAiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
const searchIndexName = process.env.AZURE_SEARCH_INDEX;
const searchApiKey = process.env.AZURE_SEARCH_API_KEY;

// ✅ Pravilna API putanja za Azure OpenAI
const openAiApiUrl = `${azureOpenAiEndpoint}/openai/deployments/${azureOpenAiDeployment}/chat/completions?api-version=2023-07-01-preview`;

// ✅ Ispravan HTTPS agent
const httpsAgent = new https.Agent({
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
  rejectUnauthorized: true,
});

// ✅ Funkcija za dohvaćanje relevantnih dokumenata iz Azure Cognitive Search
async function fetchFromAzureSearch(query) {
    try {
        const response = await axios.post(
            `${searchEndpoint}/indexes/${searchIndexName}/docs/search?api-version=2021-04-30-Preview`,
            {
                search: query,
                top: 5, // broj najrelevantnijih rezultata
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': searchApiKey,
                }
            }
        );

        const hits = response.data.value;
        const combinedText = hits.map(hit => hit.content || JSON.stringify(hit)).join('\n\n');
        return combinedText;

    } catch (err) {
        console.error("Greška u Azure Search:", err.response?.data || err.message);
        return "";
    }
}

// ✅ Filtriranje relevantnih dijelova konteksta na temelju upita
function filterRelevantContext(query, context) {
    const relevantParts = context.split('\n').filter(part => part.toLowerCase().includes(query.toLowerCase())); 
    return relevantParts.join('\n');
}

// ✅ Generiranje odgovora koristeći Azure OpenAI
async function generateAzureOpenAIResponse(query, context) {
    try {
        const limitedContext = context.length > 20000 
            ? context.substring(0, 20000) + "... [sadržaj skraćen]" 
            : context;

        // Pretraga ključnih riječi u dokumentima i filtriranje samo relevantnih informacija
        const filteredContext = filterRelevantContext(query, limitedContext);
        
        const response = await axios.post(
            openAiApiUrl,
            {
                model: "gpt-3.5-turbo", // Možeš promijeniti na drugi model ako je dostupan
                messages: [
                    { 
                        role: "system", 
                        content: "Ti si asistent koji koristi podatke pohranjene u Azure Cognitive Search-u. Tvoj zadatak je odgovarati korisnicima samo koristeći te podatke, i nikako ne koristiti informacije s interneta osim ako to nije izričito rečeno. Ako nemaš informacija, reci korisniku da ne znaš odgovor. Ako se upit odnosi na neki specifičan dokument, odgovori koristeći informacije iz tog dokumenta." 
                    },
                    { role: "user", content: query },
                    { role: "assistant", content: filteredContext }
                ],
                max_tokens: 1000
            },
            { 
                headers: { 
                    'api-key': azureOpenAiKey, // Azure koristi 'api-key' umjesto 'Authorization'
                    'Content-Type': 'application/json'
                },
                httpsAgent: httpsAgent
            }
        );

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Azure OpenAI greška:", error.response?.data || error.message);
        return "Nažalost, trenutno ne mogu odgovoriti na pitanje. Pokušajte ponovno kasnije.";
    }
}

// ✅ Chat endpoint
app.post('/chat', async (req, res) => {
    try {
        if (!req.body.message?.trim()) {
            return res.status(400).json({ error: "Poruka je obavezna" });
        }

        const userMessage = req.body.message.substring(0, 1000);
        const documents = await fetchFromAzureSearch(userMessage); // Dohvati dokumente iz Azure Search
        const botResponse = await generateAzureOpenAIResponse(userMessage, documents);
        
        res.json({ 
            response: botResponse,
            contextLength: documents.length 
        });
    } catch (error) {
        console.error("Chat greška:", error);
        res.status(500).json({ error: "Došlo je do greške na serveru" });
    }
});

// ✅ Osnovne rute
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ Pokretanje servera
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server pokrenut na http://localhost:${PORT}`);
});
