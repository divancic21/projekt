const express = require('express');
const axios = require('axios');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const path = require('path');
const https = require('https');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup za upload
const upload = multer({ dest: 'uploads/' });

// Env varijable
const azureOpenAiKey = process.env.AZURE_OPENAI_KEY;
const azureOpenAiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureOpenAiDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
const searchIndexName = process.env.AZURE_SEARCH_INDEX;
const searchApiKey = process.env.AZURE_SEARCH_API_KEY;

const azureCvEndpoint = process.env.AZURE_CV_ENDPOINT;
const azureCvKey = process.env.AZURE_CV_KEY;

const openAiApiUrl = `${azureOpenAiEndpoint}/openai/deployments/${azureOpenAiDeployment}/chat/completions?api-version=2023-07-01-preview`;

const httpsAgent = new https.Agent({
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
  rejectUnauthorized: true,
});

// --- OCR funkcija za slike (Azure Computer Vision) ---
async function ocrImageAzure(imagePath) {
  try {
    const imageData = fs.readFileSync(imagePath);

    const url = `${azureCvEndpoint}/vision/v3.2/ocr?language=unk&detectOrientation=true`;

    const response = await axios.post(url, imageData, {
      headers: {
        'Ocp-Apim-Subscription-Key': azureCvKey,
        'Content-Type': 'application/octet-stream',
      },
      httpsAgent,
    });

    // Parsiraj OCR rezultat u tekst
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
    console.error("OCR greška:", error.response?.data || error.message);
    return "";
  }
}

// --- Endpoint za upload PDF ---
app.post('/upload-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Datoteka je obavezna" });

  try {
    const dataBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(dataBuffer);

    fs.unlinkSync(req.file.path);

    res.json({ text: pdfData.text });
  } catch (error) {
    console.error("PDF parsiranje greška:", error);
    res.status(500).json({ error: "Greška pri parsiranju PDF-a" });
  }
});

// --- Endpoint za upload slike ---
app.post('/upload-image', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Slika je obavezna" });

  try {
    const text = await ocrImageAzure(req.file.path);

    fs.unlinkSync(req.file.path);

    res.json({ text });
  } catch (error) {
    console.error("OCR upload greška:", error);
    res.status(500).json({ error: "Greška pri OCR-u slike" });
  }
});

// --- Dohvat dokumenata iz Azure Search ---
async function fetchFromAzureSearch(query) {
  try {
    const response = await axios.post(
      `${searchEndpoint}/indexes/${searchIndexName}/docs/search?api-version=2021-04-30-Preview`,
      {
        search: query,
        top: 7, // malo veći broj da imamo širi izbor dokumenata
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': searchApiKey,
        }
      }
    );

    const hits = response.data.value;

    // Svaki dokument ima content i izvor (metadata)
    return hits.map(hit => ({
      content: hit.content || "",
      source: hit.metadata_storage_name || hit.source || "Nepoznati izvor"
    }));
  } catch (err) {
    console.error("Azure Search greška:", err.response?.data || err.message);
    return [];
  }
}

// --- Napredna filtracija relevantnih dokumenata ---
// - uzima u obzir duljinu riječi, ignorira česte riječi, koristi stemming / lemmatization (pojednostavljeno)
function filterRelevantDocuments(query, documents) {
  const stopwords = new Set([
    "i", "u", "na", "za", "je", "su", "se", "to", "od", "da", "ne", "a", "koji", "što",
    "što", "kao", "ali", "ili", "pa", "ako", "te", "će", "što"
  ]);

  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3 && !stopwords.has(w));

  return documents.filter(doc => {
    const text = doc.content.toLowerCase();
    // Traži da se barem jedna ključna riječ pojavi u dokumentu
    return queryWords.some(kw => text.includes(kw));
  });
}

// --- Optimalno građenje konteksta s rezanjem i formatiranjem ---
// - Pazimo da maksimalna dužina tokena ne bude prevelika
// - Čistimo višestruke praznine, dodajemo jasne separatore
function buildContextFromDocuments(documents, maxLength = 18000) {
  let context = "";
  for (const doc of documents) {
    // Ukloni višestruke nove linije i suvišne razmake iz sadržaja
    const cleanContent = doc.content
      .replace(/\s+/g, " ")
      .trim();

    const segment = `${cleanContent}\nIzvor: ${doc.source}\n---\n`;

    if ((context.length + segment.length) > maxLength) {
      context += "... [sadržaj je skraćen zbog ograničenja duljine]\n";
      break;
    }
    context += segment;
  }
  return context.trim();
}

// --- Generiranje odgovora preko Azure OpenAI s poboljšanim promptom ---
async function generateAzureOpenAIResponse(query, context) {
  if (!context || context.trim() === "") {
    return "Na temelju dostupnih dokumenata, ne mogu pronaći odgovor na to pitanje.";
  }

  try {
    const response = await axios.post(
      openAiApiUrl,
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `Ti si stručan asistent koji odgovara na pitanja koristeći isključivo informacije iz dokumenata dostavljenih u svakom upitu.

Ne koristi nikakvo vlastito znanje ili vanjske izvore, čak i ako znaš odgovor.

Ako dokumenti ne sadrže dovoljne informacije, reci jasno da ne možeš pouzdano odgovoriti.

Odgovaraj jasno, profesionalno i sažeto.

Na kraju odgovora navedi konkretan izvor za svaku ključnu tvrdnju, u formatu:
"Izvor: [naziv dokumenta]"

Nikad ne izmišljaj sadržaj ni izvore.`


          },
          {
            role: "user",
            content: `Odgovori na sljedeće pitanje koristeći isključivo informacije iz danih dokumenata. Ako informacije nisu dostupne, reci da ne možeš pouzdano odgovoriti.

            Pitanje:
            ${query}

            Dokumenti:
            ${context}`

          }
        ],
        max_tokens: 1000,
        temperature: 0.6, // konzervativni, precizni odgovori
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      },
      {
        headers: {
          'api-key': azureOpenAiKey,
          'Content-Type': 'application/json',
        },
        httpsAgent,
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Azure OpenAI greška:", error.response?.data || error.message);
    return "Nažalost, trenutno ne mogu odgovoriti na pitanje. Pokušajte ponovno kasnije.";
  }
}

// --- Chat endpoint ---
app.post('/chat', async (req, res) => {
  try {
    const userMessage = req.body.message?.trim();
    if (!userMessage) return res.status(400).json({ error: "Poruka je obavezna" });

    // Dohvati dokumente s Azure Search
    const allDocuments = await fetchFromAzureSearch(userMessage);

    // Filtriraj relevantne dokumente
    const relevantDocs = filterRelevantDocuments(userMessage, allDocuments);

    // Izgradi kontekst za model
    const context = buildContextFromDocuments(relevantDocs);

    // Generiraj odgovor
    const answer = await generateAzureOpenAIResponse(userMessage, context);

    res.json({
      response: answer,
      contextLength: context.length,
      documentsCount: relevantDocs.length
    });
  } catch (error) {
    console.error("Chat greška:", error);
    res.status(500).json({ error: "Došlo je do greške na serveru" });
  }
});

// --- Početna stranica ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server pokrenut na http://localhost:${PORT}`);
});
