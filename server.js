// server.js - Backend com Cofre Individual de Usuário (Firebase)
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const pacotePdf = require('pdf-parse'); 
const { OpenAI } = require('openai'); 

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. CONFIGURAÇÃO DE SEGURANÇA (VARIÁVEIS DE AMBIENTE)
// ==========================================
const apiKey = process.env.OPENAI_API_KEY; 
const mongoURI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

if (!apiKey || !mongoURI) {
    console.error("⚠️ ALERTA: Chaves de API ou Banco de Dados não configuradas!");
}

const openai = new OpenAI({ apiKey: apiKey });

// ==========================================
// 2. CONEXÃO COM O MONGODB (NUVEM)
// ==========================================
mongoose.connect(mongoURI)
    .then(() => console.log('✅ Banco de Dados MongoDB Conectado com Sucesso!'))
    .catch(err => console.error('❌ Erro ao conectar no MongoDB:', err));

// ==========================================
// 3. SCHEMAS (MODELOS DE DADOS)
// ==========================================
const MinitarefaSchema = new mongoose.Schema({ id: String, texto: String, concluida: Boolean });
const TopicoSchema = new mongoose.Schema({ 
    id: String, nome: String, concluido: Boolean, acertos: Number, erros: Number, 
    detalhesErros: [String], revisaoAtiva: Boolean, revisaoTempo: Number, 
    revisaoUnidade: String, revisaoInicio: Number, miniTarefas: [MinitarefaSchema] 
});
const AreaSchema = new mongoose.Schema({ id: String, nome: String, cor: String, sub: [TopicoSchema] });

// ATENÇÃO: Adicionado o campo userId obrigatório para separar os usuários
const EditalSchema = new mongoose.Schema({ 
    userId: { type: String, required: true }, 
    editalId: { type: String, required: true }, 
    nome: String, 
    areas: [AreaSchema] 
});
const EditalModel = mongoose.model('Edital', EditalSchema);

const QuestaoSchema = new mongoose.Schema({ disciplina: String, enunciado: String, alternativas: [String], gabarito: String });
const QuestaoModel = mongoose.model('Questao', QuestaoSchema);

// ==========================================
// 4. CONFIGURAÇÃO DE UPLOAD
// ==========================================
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// 5. ROTAS DA API
// ==========================================

// Rota: Buscar progressos salvos (AGORA FILTRA PELO USUÁRIO)
app.get('/api/editais/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const editaisSalvos = await EditalModel.find({ userId: userId });
        res.json(editaisSalvos);
    } catch (err) {
        res.status(500).json({ erro: "Falha ao buscar progresso no banco." });
    }
});

// Rota: Salvar progresso (AGORA EXIGE O USUÁRIO)
app.post('/api/editais', async (req, res) => {
    try {
        const dados = req.body;
        if (!dados.userId) return res.status(400).json({ erro: "Usuário não autenticado." });

        const editalAtualizado = await EditalModel.findOneAndUpdate(
            { userId: dados.userId, editalId: dados.editalId }, 
            dados, 
            { returnDocument: 'after', upsert: true } 
        );
        res.json({ mensagem: "Progresso salvo na nuvem!", edital: editalAtualizado });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao salvar as edições." });
    }
});

// Rota: Processar PDF com Cargo e IA (OpenAI)
app.post('/api/analisar-pdf', upload.single('arquivoPdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo enviado." });
        
        // Verifica se o usuário mandou o crachá
        const userId = req.body.userId;
        if (!userId) return res.status(400).json({ erro: "Você precisa estar logado para usar a IA." });
        
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

        console.log("🤖 Estruturando o edital inteligentemente (OpenAI)...");

        const promptInstrucao = `
        Abaixo está o texto extraído de um edital de concurso público.
        O usuário deseja estudar EXCLUSIVAMENTE para o cargo de: "${cargoDesejado}".

        Sua tarefa é extrair o CONTEÚDO PROGRAMÁTICO e montar a árvore de estudos seguindo estas 4 REGRAS RÍGIDAS E MATEMÁTICAS:
        
        1. CONHECIMENTOS COMUNS POR ESCOLARIDADE: Identifique no edital o nível de escolaridade exigido para o cargo "${cargoDesejado}" (Ex: Nível Médio, Nível Superior). Busque no edital a sessão de "Conhecimentos Comuns" ou "Conhecimentos Gerais" aplicável a esse nível de escolaridade e inclua essas matérias na extração.
        2. DISCIPLINAS (Áreas) = SESSÕES: Crie uma "Área" separada para CADA disciplina do edital. Elas geralmente aparecem em letras maiúsculas seguidas de dois pontos (Ex: LÍNGUA PORTUGUESA:, RACIOCÍNIO LÓGICO:). 
           - NUNCA agrupe disciplinas como "Língua Portuguesa" e "Raciocínio Lógico" dentro de um tópico chamado "Conhecimentos Gerais". Cada matéria deve ser uma Disciplina/Área própria.
           - A sessão "CONHECIMENTOS ESPECÍFICOS" deve SEMPRE ser criada como uma Área própria.
        3. TÓPICOS (Sub) = APENAS NUMERAÇÃO PRINCIPAL: Dentro de cada Disciplina, os tópicos criados devem ser EXATAMENTE os itens listados com a numeração principal inteira (Ex: 1, 2, 3, 4...).
        4. IGNORAR DECIMAIS: Você é ESTRITAMENTE PROIBIDO de criar tópicos para numerações decimais (1.1, 1.2, 1.3...). Esses subtópicos devem ser totalmente ignorados na separação de tópicos. 
           Exemplo Prático: Se o texto disser "1. Leitura e interpretação textual. 1.1. Leitura, compreensão. 2. Sintaxe e construção frasal", você criará APENAS DOIS tópicos: "1. Leitura e interpretação textual" e "2. Sintaxe e construção frasal".

        Você DEVE usar EXATAMENTE a estrutura JSON abaixo para o retorno:
        {
            "nome": "${cargoDesejado} - Estruturado",
            "areas": [
                {
                    "id": "a_unico",
                    "nome": "NOME DA DISCIPLINA (Ex: LÍNGUA PORTUGUESA)",
                    "cor": "#0fb9b1",
                    "sub": [
                        {
                            "id": "s_unico",
                            "nome": "Numeração e Tópico Principal (Ex: 1. Leitura e interpretação textual)",
                            "concluido": false,
                            "acertos": 0,
                            "erros": 0,
                            "detalhesErros": [],
                            "revisaoAtiva": false,
                            "revisaoTempo": 0,
                            "revisaoUnidade": "dias",
                            "revisaoInicio": null,
                            "miniTarefas": []
                        }
                    ]
                }
            ]
        }

        Texto do Edital (Siga as regras de numeração à risca):
        ${textoEdital}
        `;

        const resposta = await openai.chat.completions.create({
            model: "gpt-4o-mini", 
            response_format: { type: "json_object" }, 
            messages: [
                { role: "system", content: "Você é um especialista em estruturação de editais focados na extração estrita de sessões e numerações principais. Você retorna APENAS JSON válido." },
                { role: "user", content: promptInstrucao }
            ],
            temperature: 0.1 
        });

        const respostaTexto = resposta.choices[0].message.content;
        const editalEstruturadoIA = JSON.parse(respostaTexto);
        
        // Aplica as credenciais na resposta da IA
        editalEstruturadoIA.userId = userId;
        editalEstruturadoIA.editalId = 'edital-' + Date.now();
        editalEstruturadoIA.areas.forEach((area, i) => {
            area.id = 'a' + Date.now() + i;
            area.sub.forEach((sub, j) => { sub.id = 's' + Date.now() + i + j; });
        });

        console.log(`✅ Edital estruturado perfeitamente e salvo no BD para o usuário ${userId}!`);
        const editalSalvo = await EditalModel.create(editalEstruturadoIA);
        res.json(editalSalvo);

    } catch (err) {
        console.error("❌ Erro ao processar IA ou PDF:", err);
        res.status(500).json({ erro: "Falha ao processar o arquivo PDF na IA." });
    }
});

// NOVA ROTA: Gerador de Questões de Alto Nível (Simulador com Buffer)
app.post('/api/gerar-questoes', async (req, res) => {
    try {
        const { topico, disciplina, quantidade } = req.body;
        
        const promptInstrucao = `
        Você é um elaborador de provas SÊNIOR das bancas mais rigorosas do Brasil (FGV, FCC, Cesgranrio, Cebraspe Múltipla Escolha, IDECAN).
        Sua missão é criar ${quantidade} questões INÉDITAS de múltipla escolha sobre o tópico: "${topico}" (Disciplina: "${disciplina}").
        
        REGRAS EXTREMAS DE RIGOR TÉCNICO:
        1. NUNCA crie questões com erros crassos ou ambiguidades. O gabarito deve ser incontestável.
        2. O nível de dificuldade deve ser ALTO (questões para selecionar os melhores candidatos).
        3. Crie casos práticos, situações-problema ou análises teóricas profundas no enunciado, fugindo do "decoreba" simples.
        4. OBRIGATÓRIO: 5 alternativas exatas, prefixadas estritamente com A), B), C), D), E). Apenas UMA correta.
        5. Forneça uma justificativa didática e completa detalhando por que o gabarito está correto e onde está o erro nas outras opções.

        Você DEVE usar EXATAMENTE a estrutura JSON abaixo para o retorno:
        {
            "questoes": [
                {
                    "id": "gerado_por_voce_uuid_aqui",
                    "enunciado": "Texto completo e complexo da questão...",
                    "alternativas": [
                        "A) Texto da alternativa...",
                        "B) Texto da alternativa...",
                        "C) Texto da alternativa...",
                        "D) Texto da alternativa...",
                        "E) Texto da alternativa..."
                    ],
                    "gabarito": "A",
                    "justificativa": "Explicação técnica detalhada."
                }
            ]
        }
        `;

        const resposta = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "Você é o mais rigoroso examinador de concursos públicos do Brasil. Responda apenas em JSON." },
                { role: "user", content: promptInstrucao }
            ],
            temperature: 0.2
        });

        const questoesGeradas = JSON.parse(resposta.choices[0].message.content);
        res.json(questoesGeradas);

    } catch (err) {
        console.error("❌ Erro ao gerar questões:", err);
        res.status(500).json({ erro: "Falha ao gerar questões com a IA." });
    }
});

// Rota: Buscar ranking de concursos
const bancoDeConcursos = [
    { palavrasChave: ['geografia', 'petrolina', 'professor', 'seduc'], dados: { id: 'concurso-pe-geo', nome: "Prefeitura de Petrolina - Professor de Geografia", pesoGerais: 1, pesoEspecif: 2, totalVagas: 15, notaCorteHist: 85, notaPrimeiroHist: 110 } }
];

app.get('/api/buscar-concurso', (req, res) => {
    const termo = req.query.q;
    if (!termo) return res.status(400).json({ erro: "Envie um termo de busca." });
    
    let concursoEncontrado = null; let maxMatch = 0;
    bancoDeConcursos.forEach(c => {
        let matchCount = 0;
        c.palavrasChave.forEach(p => { if (termo.toLowerCase().includes(p)) matchCount++; });
        if (matchCount > maxMatch) { maxMatch = matchCount; concursoEncontrado = c.dados; }
    });
    
    setTimeout(() => {
        if (concursoEncontrado) res.json(concursoEncontrado);
        else res.status(404).json({ erro: "Edital não encontrado." });
    }, 1500);
});

// ==========================================
// INICIA O SERVIDOR
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 Backend operante na porta ${PORT} (Hospedado na Nuvem)`);
});