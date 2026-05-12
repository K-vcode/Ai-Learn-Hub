require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { GoogleGenAI } = require("@google/genai");
const axios = require("axios");
const Groq = require("groq-sdk");
const FormData = require('form-data');
const { pipeline } = require("@xenova/transformers");
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();

const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://192.168.1.105:3000",
  "http://192.168.1.105:5000",
  "http://10.76.134.9:3000",
  "http://10.76.134.9:5000",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost",
  ...(process.env.CLIENT_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));
app.options(/.*/, cors());


app.use(express.json({ limit: '10mb' }));

// ==========================
// âœ… MONGODB CONNECTION
// ==========================
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("âœ… MongoDB Connected"))
.catch(err => console.log("âŒ MongoDB Error:", err));

// ==========================
// âœ… USER SCHEMA
// ==========================
const UserSchema = new mongoose.Schema({
  fullname: String,
  email: { type: String, unique: true },
  username: { type: String, unique: true },
  password: String
});
const User = mongoose.model("User", UserSchema);

// ==========================
// ðŸ“Š SCOREBOARD SCHEMA
// ==========================
const QuizAttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  quizTitle: { type: String, required: true },
  difficulty: { type: String, required: true },
  score: { type: Number, required: true },
  totalQuestions: { type: Number, required: true },
  percentage: { type: Number, required: true },
  answers: { type: Array, default: [] },
  completedAt: { type: Date, default: Date.now }
});
const QuizAttempt = mongoose.model("QuizAttempt", QuizAttemptSchema);

// ==========================
// ðŸ” SIGNUP API
// ==========================
app.post("/api/signup", async (req, res) => {
  try {
    const { fullname, email, username, password } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) return res.status(400).json({ message: "User already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ fullname, email, username, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ message: "Signup successful" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ==========================
// ðŸ” LOGIN API
// ==========================
app.post("/api/login", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const loginValue = username || email;
    const user = await User.findOne({ 
      $or: [
        { email: { $regex: new RegExp(`^${loginValue}$`, 'i') } },
        { username: { $regex: new RegExp(`^${loginValue}$`, 'i') } }
      ]
    });
    if (!user) return res.status(400).json({ message: "Invalid email/username or password" });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid email/username or password" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.json({ success: true, message: "Login successful", token, user: { id: user._id, username: user.username, email: user.email, fullname: user.fullname } });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ==========================
// ðŸ¤– GROQ AI SETUP
// ==========================
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==========================
// ðŸ¤– AI CONTENT GENERATION API (language aware)
// ==========================
app.post("/api/generate-content", async (req, res) => {
  try {
    const { prompt, image, language = "en" } = req.body;
    if (!prompt && !image) return res.status(400).json({ success: false, error: "Please provide input" });
    let finalPrompt = prompt || "";
    const languageNames = { en: "English", ta: "Tamil", hi: "Hindi" };
    const targetLang = languageNames[language] || "English";
    const systemMessage = `You are a helpful AI assistant. Always respond in ${targetLang} language only. Do not mix languages. If the user asks in English but the target language is ${targetLang}, still respond in ${targetLang}.`;
    const chatCompletion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "system", content: systemMessage }, { role: "user", content: finalPrompt }]
    });
    res.json({ success: true, result: chatCompletion.choices[0].message.content });
  } catch (err) {
    console.log("âŒ ERROR:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================
// ðŸ–¼ï¸ FREE OCR API WITH AI
// ==========================
app.post("/api/analyze-image", async (req, res) => {
  try {
    const { imageBase64, prompt, language } = req.body;
    if (!imageBase64) return res.status(400).json({ success: false, error: "Image is required" });
    console.log("ðŸ” Analyzing image with free OCR.space API...");
    const formData = new FormData();
    formData.append('base64Image', `data:image/jpeg;base64,${imageBase64}`);
    formData.append('apikey', 'helloworld');
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    const response = await axios.post('https://api.ocr.space/parse/image', formData, { headers: formData.getHeaders() });
    const extractedText = response.data.ParsedResults?.[0]?.ParsedText || "No text found";
    console.log("âœ… Text extracted successfully");
    if (prompt && extractedText !== "No text found") {
      let aiPrompt = `${prompt}\n\nHere is the text extracted from the image:\n\n${extractedText}`;
      if (!prompt || prompt.trim() === "") aiPrompt = `Please analyze and explain the following text extracted from an image:\n\n${extractedText}`;
      const chatCompletion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "system", content: "You are an AI assistant that helps analyze text extracted from images." }, { role: "user", content: aiPrompt }],
        temperature: 0.7, max_tokens: 2000
      });
      const aiResponse = chatCompletion.choices[0].message.content;
      return res.json({ success: true, extractedText, aiAnalysis: aiResponse, raw: response.data });
    }
    res.json({ success: true, extractedText, text: extractedText, raw: response.data });
  } catch (error) {
    console.error("âŒ OCR Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Image analysis failed", details: error.message });
  }
});

// ==========================
// ðŸ–¼ï¸ IMAGE + AI COMBINED ANALYSIS
// ==========================
app.post("/api/analyze-image-with-ai", async (req, res) => {
  try {
    const { imageBase64, prompt, language, specificTask } = req.body;
    if (!imageBase64) return res.status(400).json({ success: false, error: "Image is required" });
    const formData = new FormData();
    formData.append('base64Image', `data:image/jpeg;base64,${imageBase64}`);
    formData.append('apikey', 'helloworld');
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, { headers: formData.getHeaders() });
    const extractedText = ocrResponse.data.ParsedResults?.[0]?.ParsedText || "";
    if (!extractedText || extractedText === "No text found") return res.json({ success: false, error: "No text found in the image", extractedText: "" });
    let aiPrompt = "", systemMessage = "";
    if (specificTask === "explain") { systemMessage = "You are an expert at explaining text."; aiPrompt = `Please explain:\n${extractedText}`; }
    else if (specificTask === "summarize") { systemMessage = "You are an expert at summarizing."; aiPrompt = `Summarize:\n${extractedText}`; }
    else if (specificTask === "quiz") { systemMessage = "Expert quiz generator."; aiPrompt = `Create 5 MCQs from:\n${extractedText}`; }
    else if (specificTask === "translate") { const targetLang = language || "English"; systemMessage = "Translator."; aiPrompt = `Translate to ${targetLang}:\n${extractedText}`; }
    else { systemMessage = "Helpful AI assistant."; aiPrompt = prompt ? `${prompt}\n\nText:\n${extractedText}` : `Analyze:\n${extractedText}`; }
    const chatCompletion = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: systemMessage }, { role: "user", content: aiPrompt }], temperature: 0.7, max_tokens: 4000 });
    let parsedResponse = chatCompletion.choices[0].message.content;
    try { if (parsedResponse.trim().startsWith('{') || parsedResponse.trim().startsWith('[')) parsedResponse = JSON.parse(parsedResponse); } catch(e) {}
    res.json({ success: true, extractedText, result: parsedResponse, task: specificTask || "analysis" });
  } catch (error) {
    console.error("âŒ Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Analysis failed", details: error.message });
  }
});

// ==========================
// ðŸ“ NOTE2QUIZ - GENERATE QUIZ FROM NOTES
// ==========================
app.post("/api/generate-quiz", async (req, res) => {
  try {
    const { notes, difficulty } = req.body;
    if (!notes || notes.trim().length === 0) return res.status(400).json({ success: false, error: "Notes are required" });
    let difficultyPrompt = "", numQuestions = 5;
    if (difficulty === 'easy') { difficultyPrompt = "Create basic questions."; numQuestions = 5; }
    else if (difficulty === 'medium') { difficultyPrompt = "Create moderate questions."; numQuestions = 7; }
    else if (difficulty === 'hard') { difficultyPrompt = "Create challenging questions."; numQuestions = 10; }
    else { difficultyPrompt = "Create moderate questions."; numQuestions = 5; }
    const prompt = `Based on notes, generate a quiz with ${numQuestions} MCQs. Difficulty: ${difficulty}. Return ONLY valid JSON. Format: {"title":"...","difficulty":"${difficulty}","questions":[{"id":1,"text":"...","options":["..."],"correct":0,"explanation":"..."}]}\n\nNotes:\n${notes}`;
    const chatCompletion = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: "Expert quiz generator. Return only valid JSON." }, { role: "user", content: prompt }], temperature: 0.7, max_tokens: 4000 });
    let responseText = chatCompletion.choices[0].message.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonStart = responseText.indexOf('{'), jsonEnd = responseText.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) responseText = responseText.substring(jsonStart, jsonEnd + 1);
    responseText = responseText.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    let quizData = JSON.parse(responseText);
    if (!quizData.questions || !Array.isArray(quizData.questions)) throw new Error("Invalid format");
    quizData.questions = quizData.questions.map((q, i) => ({ id: q.id || i+1, text: q.text || q.question || "Missing", options: q.options || ["A","B","C","D"], correct: q.correct !== undefined ? q.correct : 0, explanation: q.explanation || "No explanation" }));
    res.json({ success: true, quiz: quizData });
  } catch (error) {
    console.error("âŒ Quiz generation error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================
// ðŸ“Š SCOREBOARD API ENDPOINTS
// ==========================
app.post("/api/save-quiz-score", async (req, res) => {
  try {
    const { userId, username, quizTitle, difficulty, score, totalQuestions, percentage, answers } = req.body;
    if (!userId || !username || !quizTitle) return res.status(400).json({ success: false, error: "Missing required fields" });
    const quizAttempt = new QuizAttempt({ userId, username, quizTitle, difficulty: difficulty || "Medium", score, totalQuestions, percentage, answers: answers || [] });
    await quizAttempt.save();
    res.json({ success: true, message: "Score saved", attempt: quizAttempt });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.get("/api/get-quiz-scores", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: "Authentication required" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const scores = await QuizAttempt.find({ userId: decoded.id }).sort({ completedAt: -1 });
    res.json({ success: true, scores });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.delete("/api/clear-quiz-history", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: "Authentication required" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    await QuizAttempt.deleteMany({ userId: decoded.id });
    res.json({ success: true, message: "History cleared" });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ==========================
// ðŸ”— SHARED QUIZ ROUTE
// ==========================
app.post("/api/shared-quiz", async (req, res) => {
  try {
    const { encodedData } = req.body;
    if (!encodedData) return res.status(400).json({ success: false, error: "No quiz data provided" });
    const decodedData = Buffer.from(encodedData, 'base64').toString('utf-8');
    const quizData = JSON.parse(decodedData);
    res.json({ success: true, quiz: quizData });
  } catch (error) { res.status(500).json({ success: false, error: "Invalid quiz link" }); }
});

// ==========================
// ðŸ¤– LOCAL AI IMAGE MODEL (Xenova pipeline) - FALLBACK FOR VISUAL DESCRIPTION
// ==========================
let imageModel = null;
let modelLoading = false;

async function loadImageModel() {
  if (imageModel) return imageModel;
  if (modelLoading) {
    while (modelLoading) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return imageModel;
  }
  try {
    console.log("ðŸ”„ Loading image recognition model (first time: 20-30 seconds)...");
    modelLoading = true;
    imageModel = await pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning");
    console.log("âœ… Image Recognition AI Model Loaded Successfully!");
  } catch (error) {
    console.error("âŒ Failed to load vision model:", error.message);
    imageModel = null;
  } finally {
    modelLoading = false;
  }
  return imageModel;
}

app.get("/", (req, res) => {
  res.json({ success: true, message: "AI Learn Hub backend is running" });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    mongoConfigured: Boolean(process.env.MONGO_URI)
  });
});

// ==========================
// ðŸ–¼ï¸ MAIN LOCAL IMAGE AI (OCR FIRST, THEN VISION FALLBACK)
// ==========================
app.post("/api/local-image-ai", async (req, res) => {
  let tempFilePath = null;
  try {
    const { imageBase64, prompt, language = "en" } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: "Image required" });
    }

    console.log("ðŸ” Step 1: Attempting OCR to extract text from image...");
    let base64String = imageBase64;
    if (imageBase64.includes(',')) {
      base64String = imageBase64.split(',')[1];
    }

    let extractedText = "";
    let ocrSuccess = false;

    // 1. OCR attempt
    try {
      const formData = new FormData();
      formData.append('base64Image', `data:image/jpeg;base64,${base64String}`);
      formData.append('apikey', 'helloworld');
      formData.append('language', 'eng');
      formData.append('isOverlayRequired', 'false');
      formData.append('OCREngine', '2');

      const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, {
        headers: { ...formData.getHeaders() },
        timeout: 15000
      });
      extractedText = ocrResponse.data?.ParsedResults?.[0]?.ParsedText || "";
      extractedText = extractedText.trim();
      if (extractedText && extractedText !== "No text found" && extractedText.length > 10) {
        ocrSuccess = true;
        console.log("âœ… OCR succeeded. Extracted text length:", extractedText.length);
      } else {
        console.log("âš ï¸ OCR found little or no text. Will fallback to vision.");
      }
    } catch (ocrErr) {
      console.log("OCR service error:", ocrErr.message);
    }

    // 2. If OCR found meaningful text â†’ explain the text content (like a teacher)
    if (ocrSuccess) {
      console.log("ðŸ“– Explaining extracted text content (no visual description)");
      const languageMap = { en: "English", ta: "Tamil", hi: "Hindi" };
      const targetLang = languageMap[language] || "English";
      const systemMsg = `You are an expert teacher. Explain the following text in a very detailed, simple, and easy-to-understand way. Provide the original meaning, context, and a full explanation. Do NOT describe the image itself â€“ only explain the written content. Respond in ${targetLang}.`;
      const userMsg = `Text from image:\n\n${extractedText}\n\nPlease explain this clearly and completely.`;

      const groqResponse = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg }
        ],
        temperature: 0.7,
        max_tokens: 2000
      });
      const explanation = groqResponse.choices[0].message.content;
      return res.json({
        success: true,
        aiAnalysis: `ðŸ“– **Content Explanation**\n\n${explanation}`,
        extractedText: extractedText,
        mode: "ocr_explanation"
      });
    }

    // 3. No text found â†’ fallback to vision model (visual description)
    console.log("ðŸ–¼ï¸ No text detected. Using vision model for visual description.");
    await loadImageModel();
    if (!imageModel) {
      return res.status(200).json({
        success: true,
        aiAnalysis: `ðŸ“· **AI Vision Model Loading**\n\nPlease wait 30 seconds and try again.`,
        loading: true
      });
    }

    // Write temp file for vision model
    const tempDir = os.tmpdir();
    tempFilePath = path.join(tempDir, `img_${Date.now()}.jpg`);
    fs.writeFileSync(tempFilePath, Buffer.from(base64String, 'base64'));

    const visionResult = await imageModel(tempFilePath);
    const shortCaption = visionResult[0].generated_text;
    console.log("âœ… Vision caption:", shortCaption);

    fs.unlinkSync(tempFilePath);
    tempFilePath = null;

    const userPrompt = (prompt || "").trim();

    // If user typed a specific question about the image, answer it using Groq + caption
    if (userPrompt) {
      const languageMap = { en: "English", ta: "Tamil", hi: "Hindi" };
      const targetLang = languageMap[language] || "English";
      const groqPrompt = `The image shows: "${shortCaption}".\nUser question: "${userPrompt}"\nPlease provide a **detailed, helpful answer** based on this visual description. Respond in ${targetLang}.`;

      const groqResponse = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are a helpful assistant describing images." },
          { role: "user", content: groqPrompt }
        ],
        temperature: 0.7,
        max_tokens: 800
      });
      const answer = groqResponse.choices[0].message.content;
      return res.json({ success: true, aiAnalysis: `ðŸ“· **Image Analysis**\n\n${answer}\n\n*(visual description: ${shortCaption})*` });
    } else {
      // No text and no prompt â€“ just return short caption
      return res.json({ success: true, aiAnalysis: `ðŸ“· **Image Analysis**\n\n${shortCaption}` });
    }

  } catch (error) {
    console.error("âŒ Image analysis error:", error);
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch(e) {}
    }
    res.status(200).json({
      success: false,
      error: error.message,
      aiAnalysis: "âš ï¸ Analysis failed. Please try again."
    });
  }
});

// ==========================
// ðŸ†• OCR + TRANSLATION + VOICE SUPPORT (ENHANCED)
// ==========================
async function translateText(text, targetLang) {
  if (!text || text.trim() === "" || targetLang === "en") return text;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
    const response = await axios.get(url, { timeout: 10000 });
    let translated = response.data?.responseData?.translatedText || text;
    translated = translated.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    return translated;
  } catch (error) {
    console.error("Translation error:", error.message);
    return text;
  }
}

app.post("/api/ocr-and-read", async (req, res) => {
  try {
    const { imageBase64, targetLang = "en" } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ success: false, error: "Image required" });
    }

    let base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

    const formData = new FormData();
    formData.append('base64Image', `data:image/jpeg;base64,${base64Data}`);
    formData.append('apikey', 'helloworld');
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('OCREngine', '2');

    const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: { ...formData.getHeaders() },
      timeout: 15000
    });

    let extractedText = ocrResponse.data?.ParsedResults?.[0]?.ParsedText || "";
    extractedText = extractedText.trim();
    if (extractedText === "No text found" || extractedText === "") {
      return res.json({
        success: true,
        extractedText: "",
        translatedText: "No text could be detected. Please try a clearer image with visible text.",
        targetLanguage: targetLang
      });
    }

    let translatedText = extractedText;
    if (targetLang !== "en") {
      translatedText = await translateText(extractedText, targetLang);
    }

    const explanationRes = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "You are an expert teacher. Explain poems and text in a very detailed, simple, and easy-to-understand way." },
        { role: "user", content: `Explain this clearly in full detail:\n\n${translatedText}` }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    res.json({
      success: true,
      extractedText: extractedText,
      translatedText: translatedText,
      explanation: explanationRes.choices[0].message.content,
      targetLanguage: targetLang
    });
  } catch (error) {
    console.error("âŒ OCR error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==========================
// ðŸŽ¤ ASK ABOUT IMAGE (voice assistant uses this)
// ==========================
app.post("/api/ask-about-image", async (req, res) => {
  try {
    const { imageBase64, question, language = "en" } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: "Image required" });
    }
    if (!question || question.trim() === "") {
      return res.status(400).json({ success: false, error: "Question required" });
    }

    console.log("ðŸŽ¤ Voice assistant question:", question);
    let base64String = imageBase64;
    if (imageBase64.includes(',')) base64String = imageBase64.split(',')[1];

    // ---- Step 1: Extract text from image using OCR ----
    let extractedText = "";
    let ocrSuccess = false;
    try {
      const formData = new FormData();
      formData.append('base64Image', `data:image/jpeg;base64,${base64String}`);
      formData.append('apikey', 'helloworld');
      formData.append('language', 'eng');
      formData.append('isOverlayRequired', 'false');
      formData.append('OCREngine', '2');
      const ocrResponse = await axios.post('https://api.ocr.space/parse/image', formData, {
        headers: { ...formData.getHeaders() },
        timeout: 15000
      });
      extractedText = ocrResponse.data?.ParsedResults?.[0]?.ParsedText || "";
      extractedText = extractedText.trim();
      if (extractedText && extractedText !== "No text found" && extractedText.length > 10) {
        ocrSuccess = true;
        console.log("âœ… OCR extracted text length:", extractedText.length);
      }
    } catch (err) {
      console.log("OCR error:", err.message);
    }

    // ---- Step 2: If no text, try vision model (only as last resort) ----
    let imageDescription = "";
    if (!ocrSuccess) {
      try {
        await loadImageModel();
        if (!imageModel) throw new Error("Vision model is not available");
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `ask_img_${Date.now()}.jpg`);
        fs.writeFileSync(tempFilePath, Buffer.from(base64String, 'base64'));
        const visionResult = await imageModel(tempFilePath);
        imageDescription = visionResult[0].generated_text;
        fs.unlinkSync(tempFilePath);
        console.log("ðŸ“· Vision description:", imageDescription);
      } catch (err) {
        console.log("Vision error:", err.message);
      }
    }

    // ---- Step 3: Build context for AI ----
    let context = "";
    if (ocrSuccess && extractedText.length > 0) {
      context = `The user uploaded an image containing this text:\n\n${extractedText}\n\n`;
    } else if (imageDescription) {
      context = `The user uploaded an image that appears to show: ${imageDescription}. `;
      context += `Do NOT describe the image visually. Focus only on any text or meaningful content. If no text, say "I could not find any readable text in this image."\n\n`;
    } else {
      context = `The user uploaded an image but no text could be extracted and the vision model is not available. `;
      context += `Politely inform the user that you cannot read the image content.\n\n`;
    }

    // ---- Step 4: Let Groq answer the question based on the content ----
    const languageMap = { en: "English", ta: "Tamil", hi: "Hindi" };
    const targetLang = languageMap[language] || "English";
    const systemMessage = `You are a smart assistant that answers questions based on the content of an image. 
You have received the following context from the image:
${context}
Now the user asks: "${question}"
Answer the question accurately and helpfully, using only the information from the context. 
If the context does not contain the answer, say "I couldn't find that information in the image."
Respond in ${targetLang} language only.`;

    const groqResponse = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: systemMessage }],
      temperature: 0.7,
      max_tokens: 1000
    });

    const answer = groqResponse.choices[0].message.content;
    res.json({ success: true, answer, hasText: ocrSuccess });

  } catch (error) {
    console.error("âŒ Ask about image error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==================== RESUME ANALYZER (NO API KEY) ====================

const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

// Multer config
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    const allowedExtensions = [".pdf", ".docx"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) cb(null, true);
    else cb(new Error("Only PDF and DOCX files are allowed"));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Resume Analysis Schema
const resumeAnalysisSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  fileName: String,
  extractedText: String,
  atsScore: Number,
  missingSkills: [String],
  grammarCorrections: [String],
  suggestions: [String],
  strengths: [String],
  weaknesses: [String],
  matchingRoles: [{ role: String, matchPercentage: Number }],
  createdAt: { type: Date, default: Date.now }
});
const ResumeAnalysis = mongoose.model("ResumeAnalysis", resumeAnalysisSchema);

// Authentication middleware (reuse your JWT)
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : null;
  if (!token) return res.status(401).json({ success: false, error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid token" });
  }
};

// Text extraction helpers
const extractPDF = async (buffer) => {
  const data = await pdfParse(buffer);
  return data.text || "";
};
const extractDOCX = async (buffer) => {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
};
const extractText = async (buffer, mimeType, fileName = "") => {
  const ext = path.extname(fileName).toLowerCase();
  if (mimeType === "application/pdf" || ext === ".pdf") return extractPDF(buffer);
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === ".docx") return extractDOCX(buffer);
  throw new Error("Unsupported file type");
};

// Local ruleâ€‘based analysis (no API key)
const analyzeResume = (text) => {
  const t = text.toLowerCase();
  const allSkills = [
    "javascript","python","java","c++","react","angular","vue","node.js","express",
    "mongodb","mysql","postgresql","aws","docker","git","typescript","html","css",
    "tailwind","php","django","flask","machine learning","ai"
  ];
  const found = allSkills.filter(skill => t.includes(skill));
  const missing = allSkills.filter(s => !t.includes(s)).slice(0, 8);

  const grammar = [];
  if (t.includes("teh")) grammar.push("'teh' â†’ 'the'");
  if (t.includes("recieve")) grammar.push("'recieve' â†’ 'receive'");
  if (t.includes("acheive")) grammar.push("'acheive' â†’ 'achieve'");
  if (grammar.length === 0) grammar.push("No obvious spelling errors.");

  const suggestions = [];
  if (text.length < 500) suggestions.push("Add more details about responsibilities.");
  if (!t.includes("quantifiable") && !t.includes("%")) suggestions.push("Add quantifiable achievements.");
  if (found.length < 4) suggestions.push("Include more relevant technical skills.");
  if (!t.includes("linkedin")) suggestions.push("Add LinkedIn profile link.");
  if (suggestions.length === 0) suggestions.push("Resume looks strong â€“ keep updating!");

  const strengths = [];
  if (found.length > 2) strengths.push(`Technical skills: ${found.slice(0,3).join(", ")}`);
  if (text.length > 1000) strengths.push("Detailed work experience.");
  if (t.includes("lead") || t.includes("managed")) strengths.push("Leadership experience shown.");
  if (strengths.length === 0) strengths.push("Clear structure.");

  const weaknesses = [];
  if (text.length < 800) weaknesses.push("Resume too short â€“ add more content.");
  if (found.length < 3) weaknesses.push("Limited technical skills listed.");
  if (!t.includes("experience")) weaknesses.push("No clear work experience section.");
  if (weaknesses.length === 0) weaknesses.push("Could be tailored for specific roles.");

  let atsScore = 50;
  if (found.length > 0) atsScore += Math.min(found.length * 4, 25);
  if (text.length > 800) atsScore += 10;
  if (text.length > 1500) atsScore += 5;
  if (t.includes("achieved") || t.includes("improved")) atsScore += 5;
  atsScore = Math.min(atsScore, 100);

  const roles = [];
  if (found.some(s => ["react","angular","vue"].includes(s))) roles.push({ role: "Frontend Developer", matchPercentage: 75 });
  if (found.some(s => ["node.js","express"].includes(s))) roles.push({ role: "Backend Developer", matchPercentage: 70 });
  if (found.includes("mongodb") || found.includes("mysql")) roles.push({ role: "Database Admin", matchPercentage: 65 });
  if (found.includes("docker") || found.includes("aws")) roles.push({ role: "DevOps Engineer", matchPercentage: 80 });
  if (found.includes("python") && found.includes("machine learning")) roles.push({ role: "AI/ML Engineer", matchPercentage: 85 });
  if (roles.length === 0) roles.push({ role: "Junior Developer", matchPercentage: 60 });

  return {
    atsScore,
    missingSkills: missing,
    grammarCorrections: grammar,
    suggestions,
    strengths,
    weaknesses,
    matchingRoles: roles.slice(0,4)
  };
};

// API endpoints
app.post("/api/resume/analyze", authMiddleware, (req, res) => {
  upload.single("resume")(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        const status = uploadErr.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        return res.status(status).json({ success: false, error: uploadErr.message });
      }
      if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

      const rawText = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
      const cleaned = rawText.replace(/\s+/g, " ").trim();
      if (!cleaned) {
        return res.status(400).json({
          success: false,
          error: "Could not extract text from this resume. Please upload a text-based PDF or DOCX file."
        });
      }

      const analysis = analyzeResume(cleaned);
      const analysisWithText = {
        ...analysis,
        fileName: req.file.originalname,
        extractedText: cleaned.substring(0, 2000)
      };
      const saved = new ResumeAnalysis({
        user: req.userId,
        fileName: req.file.originalname,
        extractedText: analysisWithText.extractedText,
        ...analysis
      });
      await saved.save();
      res.json({ success: true, analysis: analysisWithText, analysisId: saved._id });
    } catch (err) {
      console.error("Resume analyze error:", err);
      res.status(500).json({ success: false, error: err.message || "Resume analysis failed" });
    }
  });
});

app.get("/api/resume/history", authMiddleware, async (req, res) => {
  try {
    const history = await ResumeAnalysis.find({ user: req.userId }).sort("-createdAt");
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/resume/analysis/:id", authMiddleware, async (req, res) => {
  try {
    const analysis = await ResumeAnalysis.findOne({ _id: req.params.id, user: req.userId });
    if (!analysis) return res.status(404).json({ error: "Not found" });
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/resume/improve", authMiddleware, (req, res) => {
  const { originalText, suggestions } = req.body;
  if (!originalText) return res.status(400).json({ error: "Missing text" });
  let improved = originalText;
  if (suggestions?.length) {
    improved = `[AI Improvement Placeholder]\n\nBased on suggestions: ${suggestions.join(", ")}\n\nOriginal:\n${originalText}\n\nConsider adding quantifiable achievements and relevant keywords.`;
  }
  res.json({ improvedText: improved });
});

app.post("/api/resume/report", authMiddleware, async (req, res) => {
  try {
    const { analysis } = req.body;
    if (!analysis) return res.status(400).json({ error: "Missing analysis" });
    const html = `
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><style>body{font-family:Arial;padding:20px} .score{font-size:48px;color:#4F46E5}</style></head>
      <body>
        <h1>Resume Report</h1>
        <p><strong>File:</strong> ${analysis.fileName}</p>
        <p><strong>ATS Score:</strong> <span class="score">${analysis.atsScore}/100</span></p>
        <h2>Missing Skills</h2><ul>${analysis.missingSkills.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Suggestions</h2><ul>${analysis.suggestions.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Strengths</h2><ul>${analysis.strengths.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Weaknesses</h2><ul>${analysis.weaknesses.map(s=>`<li>${s}</li>`).join("")}</ul>
        <h2>Best Roles</h2><ul>${analysis.matchingRoles.map(r=>`<li>${r.role} â€“ ${r.matchPercentage}%</li>`).join("")}</ul>
      </body></html>`;
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ==========================
// ðŸš€ SERVER START
// ==========================
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});


