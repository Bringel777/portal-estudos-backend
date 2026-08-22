// server.js - Backend com Cofre Individual, Perfil Completo e Motor de Questões Sênior
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const pacotePdf = require('pdf-parse'); 
const { OpenAI } = require('openai'); 

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

// Modelo de Perfil Global do Usuário (Com suporte ao Bloco de Notas)
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
    bancoQuestoes: { type: Object, default: {} },
    minhasNotas: { type: Object, default: {} } // Armazena as anotações do Modo Foco
}, { strict: false });
const UserProfileModel = mongoose.model('UserProfile', UserProfileSchema);

// ==========================================
// 3. ROTAS DA API DE PERFIL
// ==========================================
app.get('/api/user-profile/:userId', async (req, res) => {
    try {
        const profile = await UserProfileModel.findOne({ userId: req.params.userId });
        res.json(profile || {});
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar perfil." }); }
});

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
// 4. ROTAS DA API DE EDITAIS
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

app.delete('/api/editais/:userId/:editalId', async (req, res) => {
    try {
        const { userId, editalId } = req.params;
        await EditalModel.findOneAndDelete({ userId: userId, editalId: editalId });
        res.json({ mensagem: "Edital excluído com sucesso do Banco de Dados!" });
    } catch (err) {
        res.status(500).json({ erro: "Erro ao excluir o edital." });
    }
});

// =======================================================================
// 5. ROTA OTIMIZADA DE LEITURA DE PDF (IA COM ESTRUTURA RESTRITA)
// =======================================================================
const editalJsonSchema = {
    type: "object",
    properties: {
        nome: { type: "string", description: "Nome do cargo formatado" },
        areas: {
            type: "array",
            description: "Lista de disciplinas extraídas",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    nome: { type: "string", description: "Nome exato da disciplina em caixa alta" },
                    cor: { type: "string" },
                    sub: {
                        type: "array",
                        description: "Lista de tópicos numerados da disciplina",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string" },
                                nome: { type: "string", description: "Numeração e nome do tópico principal" },
                                concluido: { type: "boolean" },
                                acertos: { type: "number" },
                                erros: { type: "number" },
                                detalhesErros: { type: "array", items: { type: "string" } },
                                revisaoAtiva: { type: "boolean" },
                                revisaoTempo: { type: "number" },
                                revisaoUnidade: { type: "string" },
                                revisaoInicio: { type: ["number", "null"] },
                                miniTarefas: { 
                                    type: "array", 
                                    items: { type: "object", properties: { id: { type: "string" }, texto: { type: "string" }, concluida: { type: "boolean" } }, required: ["id", "texto", "concluida"], additionalProperties: false } 
                                }
                            },
                            required: ["id", "nome", "concluido", "acertos", "erros", "detalhesErros", "revisaoAtiva", "revisaoTempo", "revisaoUnidade", "revisaoInicio", "miniTarefas"],
                            additionalProperties: false
                        }
                    }
                },
                required: ["id", "nome", "cor", "sub"],
                additionalProperties: false
            }
        }
    },
    required: ["nome", "areas"],
    additionalProperties: false
};

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

        textoEdital = textoEdital.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/Página \d+ de \d+/gi, '').replace(/--+|\.\.+/g, '');

        const indiceConteudo = textoEdital.search(/CONTE[UÚ]DO\s+PROGRAM[AÁ]TICO|PROGRAMAS?\s+DE\s+PROVA|ANEXO/i);
        if (indiceConteudo !== -1) { textoEdital = textoEdital.substring(indiceConteudo, indiceConteudo + 60000); }

        const promptInstrucao = `Abaixo está o texto extraído de um edital de concurso público.
O usuário deseja estudar EXCLUSIVAMENTE para o cargo de: "${cargoDesejado}".
Sua tarefa é extrair o CONTEÚDO PROGRAMÁTICO e montar a árvore de estudos seguindo estas 4 REGRAS RÍGIDAS E MATEMÁTICAS:

1. PROIBIÇÃO DE ÁREAS GENÉRICAS: É EXPRESSAMENTE PROIBIDO criar Áreas/Disciplinas com nomes aglutinadores como "Conhecimentos Gerais", "Conhecimentos Básicos", "Conhecimentos Comuns" ou "Conhecimentos Específicos".
2. ELEVAÇÃO DE MATÉRIAS A ÁREAS INDEPENDENTES: Cada matéria específica citada no edital DEVE se tornar uma "Área" (Disciplina) independente. Por exemplo, se o edital listar dentro de Conhecimentos Básicos matérias como "Língua Portuguesa", "Administração Pública", "Educação Brasileira", CADA UMA destas matérias deve ser o título de uma Área própria.
3. TÓPICOS = APENAS NUMERAÇÃO PRINCIPAL: Dentro de cada Área (Matéria), extraia como tópicos ("sub") apenas os itens com numeração inteira principal (Ex: 1, 2, 3...).
4. IGNORAR DECIMAIS E SUBTÓPICOS: PROIBIDO criar tópicos para numerações decimais (1.1, 1.2...). Preserve o layout apenas com os temas principais.

Use EXATAMENTE a estrutura JSON exigida pelo schema para o retorno.

Texto:
${textoEdital}`;

        const resposta = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_schema", json_schema: { name: "estrutura_edital", strict: true, schema: editalJsonSchema } },
            messages: [{ role: "system", content: "Você é um parser especializado em converter editais desformatados em matrizes de estudo perfeitamente organizadas." }, { role: "user", content: promptInstrucao }],
            temperature: 0.1 
        });

        const editalEstruturadoIA = JSON.parse(resposta.choices[0].message.content);
        const timeNow = Date.now();
        const coresPadrao = ['#0fb9b1', '#3498db', '#9b59b6', '#e67e22', '#2ecc71', '#1abc9c', '#e74c3c', '#8e44ad'];
        
        editalEstruturadoIA.userId = userId;
        editalEstruturadoIA.editalId = 'edital-' + timeNow;
        
        editalEstruturadoIA.areas.forEach((area, i) => {
            area.id = 'a' + timeNow + i;
            area.cor = coresPadrao[i % coresPadrao.length];
            area.sub.forEach((sub, j) => {
                sub.id = 's' + timeNow + i + j;
                sub.concluido = false; sub.acertos = 0; sub.erros = 0; sub.detalhesErros = []; sub.revisaoAtiva = false; sub.revisaoTempo = 0; sub.revisaoUnidade = 'dias'; sub.revisaoInicio = null; sub.miniTarefas = [];
            });
        });

        const editalSalvo = await EditalModel.create(editalEstruturadoIA);
        res.json(editalSalvo);

    } catch (err) { 
        console.error("Erro IA PDF:", err);
        res.status(500).json({ erro: "Falha na IA." }); 
    }
});

// =======================================================================
// 6. MOTOR SÊNIOR DE GERAÇÃO DE QUESTÕES (ALTA PERFORMANCE)
// =======================================================================
app.post('/api/gerar-questoes', async (req, res) => {
    try {
        const { topico, disciplina, quantidade } = req.body;
        
        const promptInstrucao = `Atue como um Examinador Sênior das principais bancas de concurso do Brasil (FGV, Cebraspe, FCC, Vunesp).
Sua missão é criar ${quantidade} questões INÉDITAS, complexas e de altíssimo nível sobre o tópico: "${topico}" (Disciplina: "${disciplina}").

REGRAS RÍGIDAS DE ELABORAÇÃO:
1. CONTEXTUALIZAÇÃO OBRIGATÓRIA: Toda questão DEVE ter um texto-base, situação-problema, estudo de caso ou fragmento de literatura consolidada e verdadeira. NUNCA faça perguntas diretas ou "cruas" sem contexto.
2. DIVERSIFICAÇÃO OBRIGATÓRIA DE FORMATOS: É estritamente PROIBIDO gerar todas as questões no mesmo formato. Você DEVE distribuir as ${quantidade} questões de forma EQUILIBRADA entre os 3 formatos abaixo:
   - TIPO 1 (Múltipla escolha interpretativa): Pergunta direta baseada no texto/caso.
   - TIPO 2 (Julgamento de Itens I, II, III, IV): Liste afirmações. As alternativas devem ser combinações (Ex: A) Somente I e II estão corretas).
   - TIPO 3 (Verdadeiro ou Falso): Liste afirmações para julgamento. As alternativas devem representar a sequência exata (Ex: A) V, V, F, V).
3. PADRONIZAÇÃO DE TAMANHO E GABARITO: As 5 alternativas (A, B, C, D, E) DEVEM ter um tamanho textual semelhante. A alternativa correta NUNCA deve ser a mais longa nem a mais curta. DIVERSIFIQUE ao máximo a letra do gabarito correto entre as questões geradas (evite sequências repetidas).
4. JUSTIFICATIVAS INDIVIDUAIS E EXATAS: Para CADA alternativa (A, B, C, D, E), forneça uma explicação profunda e baseada na literatura técnica. Explique linha por linha o erro sutil ou o acerto daquela alternativa específica, não fornecendo explicações genéricas.

O formato de saída DEVE ser ESTRITAMENTE o objeto JSON abaixo:
{
    "questoes": [
        {
            "id": "uuid_gerado_por_voce",
            "enunciado": "Texto base contextualizado + Afirmações (se for o caso) + Comando final da questão...",
            "alternativas": [
                "A) Texto da alternativa...",
                "B) Texto da alternativa...",
                "C) Texto da alternativa...",
                "D) Texto da alternativa...",
                "E) Texto da alternativa..."
            ],
            "gabarito": "C",
            "justificativas": {
                "A": "Explicação técnica profunda do motivo do erro/acerto.",
                "B": "Explicação técnica profunda do motivo do erro/acerto.",
                "C": "Explicação técnica profunda do motivo do erro/acerto.",
                "D": "Explicação técnica profunda do motivo do erro/acerto.",
                "E": "Explicação técnica profunda do motivo do erro/acerto."
            }
        }
    ]
}`;

        const resposta = await openai.chat.completions.create({
            model: "gpt-4o-mini", 
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "Examinador Sênior de concursos de alto nível. Você responde exclusivamente no formato JSON solicitado, com explicações individuais." }, 
                { role: "user", content: promptInstrucao }
            ], 
            temperature: 0.4 // Temperatura ajustada para garantir a variabilidade de tipos (V/F, I, II, III) e criatividade
        });
        
        res.json(JSON.parse(resposta.choices[0].message.content));
    } catch (err) { 
        console.error("Falha ao gerar questões:", err);
        res.status(500).json({ erro: "Falha IA Questões." }); 
    }
});

// =======================================================================
// 7. ROTA DE SIMULAÇÃO DE RANKING
// =======================================================================
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