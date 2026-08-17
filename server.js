// server.js - Backend com Cofre Individual e Perfil Completo
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const pacotePdf = require('pdf-parse'); 
const { OpenAI } = require('openai'); 

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Aumentado limite para salvar questões

// ==========================================
// 1. CONFIGURAÇÃO DE SEGURANÇA
// ==========================================
const apiKey = process.env.OPENAI_API_KEY; 
const mongoURI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

if (!apiKey || !mongoURI) {
    console.error("⚠️ ALERTA: Chaves de API ou Banco de Dados não configuradas!");
}

const openai = new OpenAI({ apiKey: apiKey });

mongoose.connect(mongoURI)
    .then(() => console.log('✅ Banco de Dados MongoDB Conectado com Sucesso!'))
    .catch(err => console.error('❌ Erro ao conectar no MongoDB:', err));

// ==========================================
// 2. SCHEMAS (MODELOS DE DADOS)
// ==========================================
// 2.1 Modelo dos Editais
const MinitarefaSchema = new mongoose.Schema({ id: String, texto: String, concluida: Boolean });
const TopicoSchema = new mongoose.Schema({ 
    id: String, nome: String, concluido: Boolean, acertos: Number, erros: Number, 
    detalhesErros: [String], revisaoAtiva: Boolean, revisaoTempo: Number, 
    revisaoUnidade: String, revisaoInicio: Number, miniTarefas: [MinitarefaSchema] 
});
const AreaSchema = new mongoose.Schema({ id: String, nome: String, cor: String, sub: [TopicoSchema] });
const EditalSchema = new mongoose.Schema({ 
    userId: { type: String, required: true }, 
    editalId: { type: String, required: true }, 
    nome: String, 
    areas: [AreaSchema] 
});
const EditalModel = mongoose.model('Edital', EditalSchema);

// 2.2 NOVO: Modelo de Perfil Global do Usuário
const UserProfileSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    tarefasDoDia: { type: Array, default: [] },
    tarefasDaSemana: { type: Object, default: {} },
    historicoTempo: { type: Object, default: {} },
    tempoGlobal: { type: Number, default: 0 },
    escalaTempo: { type: String, default: 'semana' },
    mostrarGraficoTempo: { type: Boolean, default: true },
    modoEscuro: { type: Boolean, default: false },
    syncAtivo: { type: Boolean, default: false },
    bancoQuestoes: { type: Object, default: {} }
}, { strict: false });
const UserProfileModel = mongoose.model('UserProfile', UserProfileSchema);

// ==========================================
// 3. ROTAS DA API DE PERFIL (NOVAS)
// ==========================================
// Rota: Buscar perfil do usuário
app.get('/api/user-profile/:userId', async (req, res) => {
    try {
        const profile = await UserProfileModel.findOne({ userId: req.params.userId });
        res.json(profile || {});
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar perfil." }); }
});

// Rota: Salvar perfil do usuário
app.post('/api/user-profile', async (req, res) => {
    try {
        if (!req.body.userId) return res.status(400).json({ erro: "Usuário não autenticado." });
        const profile = await UserProfileModel.findOneAndUpdate(
            { userId: req.body.userId }, 
            req.body, 
            { returnDocument: 'after', upsert: true } 
        );
        res.json(profile);
    } catch (err) { res.status(500).json({ erro: "Erro ao salvar perfil." }); }
});

// ==========================================
// 4. ROTAS DA API DE EDITAIS E IA
// ==========================================
app.get('/api/editais/:userId', async (req, res) => {
    try {
        const editaisSalvos = await EditalModel.find({ userId: req.params.userId });
        res.json(editaisSalvos);
    } catch (err) { res.status(500).json({ erro: "Falha ao buscar editais." }); }
});

app.post('/api/editais', async (req, res) => {
    try {
        const dados = req.body;
        if (!dados.userId) return res.status(400).json({ erro: "Usuário não autenticado." });
        const editalAtualizado = await EditalModel.findOneAndUpdate(
            { userId: dados.userId, editalId: dados.editalId }, 
            dados, { returnDocument: 'after', upsert: true } 
        );
        res.json({ edital: editalAtualizado });
    } catch (err) { res.status(500).json({ erro: "Erro ao salvar edital." }); }
});

const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/analisar-pdf', upload.single('arquivoPdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo enviado." });
        const userId = req.body.userId;
        if (!userId) return res.status(400).json({ erro: "Login necessário." });
        
        const cargoDesejado = req.body.cargo || "Não especificado";
        let textoEdital = "";

        if (pacotePdf.PDFParse) {
            const parser = new pacotePdf.PDFParse({ data: new Uint8Array(req.file.buffer) });
            const result = await parser.getText();
            textoEdital = result.text;
            if(parser.destroy) await parser.destroy(); 
        } else {
            const extrairPDF = pacotePdf.default || pacotePdf;
            const pdfExtraido = await extrairPDF(req.file.buffer); 
            textoEdital = pdfExtraido.text;
        }

        const promptInstrucao = `Abaixo está o texto extraído de um edital de concurso público.
O usuário deseja estudar EXCLUSIVAMENTE para o cargo de: "${cargoDesejado}".
Sua tarefa é extrair o CONTEÚDO PROGRAMÁTICO e montar a árvore de estudos seguindo estas 4 REGRAS RÍGIDAS E MATEMÁTICAS:
1. CONHECIMENTOS COMUNS POR ESCOLARIDADE: Identifique no edital o nível exigido para "${cargoDesejado}". Busque "Conhecimentos Comuns/Gerais" aplicáveis e inclua.
2. DISCIPLINAS = SESSÕES: Crie "Área" para CADA disciplina. 
3. TÓPICOS = APENAS NUMERAÇÃO PRINCIPAL (Ex: 1, 2, 3...).
4. IGNORAR DECIMAIS: PROIBIDO criar tópicos decimais (1.1, 1.2...).

Use EXATAMENTE a estrutura JSON:
{
    "nome": "${cargoDesejado} - Estruturado",
    "areas": [
        {
            "id": "a_unico", "nome": "NOME DA DISCIPLINA", "cor": "#0fb9b1",
            "sub": [ { "id": "s_unico", "nome": "Tópico Principal", "concluido": false, "acertos": 0, "erros": 0, "detalhesErros": [], "revisaoAtiva": false, "revisaoTempo": 0, "revisaoUnidade": "dias", "revisaoInicio": null, "miniTarefas": [] } ]
        }
    ]
}
Texto:
${textoEdital}`;

        const resposta = await openai.chat.completions.create({
            model: "gpt-4o-mini", response_format: { type: "json_object" }, 
            messages: [{ role: "system", content: "Extraia disciplinas em JSON válido." }, { role: "user", content: promptInstrucao }],
            temperature: 0.1 
        });

        const editalEstruturadoIA = JSON.parse(resposta.choices[0].message.content);
        editalEstruturadoIA.userId = userId;
        editalEstruturadoIA.editalId = 'edital-' + Date.now();
        editalEstruturadoIA.areas.forEach((area, i) => {
            area.id = 'a' + Date.now() + i;
            area.sub.forEach((sub, j) => { sub.id = 's' + Date.now() + i + j; });
        });

        const editalSalvo = await EditalModel.create(editalEstruturadoIA);
        res.json(editalSalvo);

    } catch (err) { res.status(500).json({ erro: "Falha na IA." }); }
});

app.post('/api/gerar-questoes', async (req, res) => {
    try {
        const { topico, disciplina, quantidade } = req.body;
        const promptInstrucao = `Crie ${quantidade} questões INÉDITAS de múltipla escolha sobre o tópico: "${topico}" (Disciplina: "${disciplina}").
Nível ALTO. 5 alternativas (A, B, C, D, E). Apenas UMA correta.
JSON EXATO: { "questoes": [ { "id": "uuid", "enunciado": "Texto", "alternativas": ["A) ", "B) ", "C) ", "D) ", "E) "], "gabarito": "A", "justificativa": "Explicação" } ] }`;

        const resposta = await openai.chat.completions.create({
            model: "gpt-4o-mini", response_format: { type: "json_object" },
            messages: [{ role: "system", content: "Examinador de concursos. Responda JSON." }, { role: "user", content: promptInstrucao }], temperature: 0.2
        });
        res.json(JSON.parse(resposta.choices[0].message.content));
    } catch (err) { res.status(500).json({ erro: "Falha IA Questões." }); }
});

const bancoDeConcursos = [ { palavrasChave: ['geografia', 'petrolina', 'professor', 'seduc'], dados: { id: 'concurso-pe-geo', nome: "Prefeitura de Petrolina - Professor de Geografia", pesoGerais: 1, pesoEspecif: 2, totalVagas: 15, notaCorteHist: 85, notaPrimeiroHist: 110 } } ];
app.get('/api/buscar-concurso', (req, res) => {
    const termo = req.query.q; if (!termo) return res.status(400).json({ erro: "Envie termo." });
    let concursoEncontrado = null; let maxMatch = 0;
    bancoDeConcursos.forEach(c => {
        let matchCount = 0; c.palavrasChave.forEach(p => { if (termo.toLowerCase().includes(p)) matchCount++; });
        if (matchCount > maxMatch) { maxMatch = matchCount; concursoEncontrado = c.dados; }
    });
    setTimeout(() => { if (concursoEncontrado) res.json(concursoEncontrado); else res.status(404).json({ erro: "Não encontrado." }); }, 1500);
});

app.listen(PORT, () => { console.log(`🚀 Backend Nuvem na porta ${PORT}`); });