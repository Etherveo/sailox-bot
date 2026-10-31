import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const tempDir = path.join(process.cwd(), 'tmp');

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

const detectLanguage = (code) => {
    const trimmedCode = code.trim().toLowerCase();
    if (trimmedCode.startsWith('print') || trimmedCode.includes('def ')) return { lang: 'python', ext: 'py', exec: 'python3' };
    if (trimmedCode.startsWith('<?php') || trimmedCode.includes('echo ')) return { lang: 'php', ext: 'php', exec: 'php' };
    if (trimmedCode.startsWith('public class') || trimmedCode.includes('system.out')) return { lang: 'java', ext: 'java', exec: 'java' };
    if (trimmedCode.startsWith('#include') || trimmedCode.includes('cout')) return { lang: 'cpp', ext: 'cpp', exec: 'g++' };
    if (trimmedCode.startsWith('console.log') || trimmedCode.includes('function ')) return { lang: 'javascript', ext: 'js', exec: 'node' };
    return { lang: 'javascript', ext: 'js', exec: 'node' };
};

const handler = async (m, { conn, text, command, usedPrefix }) => {
    if (!text) {
        return m.reply('Eh Senpai, kasih kode dulu dong, aku ga bisa nebak pikiran Senpai!');
    }

    const code = text.trim();
    const { lang, ext, exec: execCmd } = detectLanguage(code);
    const tempFilePath = path.join(tempDir, `temp.${ext}`);

    fs.writeFileSync(tempFilePath, code);

    if (lang === 'cpp') {
        exec(`g++ ${tempFilePath} -o ${path.join(tempDir, 'temp')}`, (compileErr) => {
            if (compileErr) {
                m.reply(`Error kompilasi C++: ${compileErr.message}`);
                fs.unlinkSync(tempFilePath);
                return;
            }
            exec(`${path.join(tempDir, 'temp')}`, (runErr, stdout, stderr) => {
                fs.unlinkSync(tempFilePath);
                fs.unlinkSync(path.join(tempDir, 'temp'));
                if (runErr) return m.reply(`Error: ${runErr.message}`);
                if (stderr) return m.reply(`Stderr: ${stderr}`);
                m.reply(`Output C++:\n${stdout}`);
            });
        });
    } else if (lang === 'java') {
        exec(`javac ${tempFilePath}`, (compileErr) => {
            if (compileErr) {
                m.reply(`Error kompilasi Java: ${compileErr.message}`);
                fs.unlinkSync(tempFilePath);
                return;
            }
            exec(`java -cp ${tempDir} temp`, (runErr, stdout, stderr) => {
                fs.unlinkSync(tempFilePath);
                fs.unlinkSync(path.join(tempDir, 'temp.class'));
                if (runErr) return m.reply(`Error: ${runErr.message}`);
                if (stderr) return m.reply(`Stderr: ${stderr}`);
                m.reply(`Output Java:\n${stdout}`);
            });
        });
    } else {
        exec(`${execCmd} ${tempFilePath}`, (error, stdout, stderr) => {
            fs.unlinkSync(tempFilePath);
            if (error) {
                m.reply(`Error ${lang}: ${error.message}`);
                return;
            }
            if (stderr) {
                m.reply(`Stderr ${lang}: ${stderr}`);
                return;
            }
            m.reply(`Output ${lang}:\n${stdout}`);
        });
    }
};

handler.help = ['o'];
handler.tags = ['owner'];
handler.command = ['o'];
handler.owner = true;

export default handler;