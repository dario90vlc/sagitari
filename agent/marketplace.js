'use strict';

/* Skill Marketplace de SAGITARI (v1.7): catálogo destacado (repos verificados
   con SKILL.md) + búsqueda en GitHub. Instalar = importFromGitHub de skills.js
   (un clic desde la UI). */

const FEATURED = [
  { repo: 'anthropics/skills', category: 'Multipack oficial', description: '20+ skills verificadas: documentos, artefactos, análisis, canvas…' },
  { repo: 'anthropics/skills/document-skills/docx', category: 'Documentos', description: 'Crear y editar documentos Word complejos.' },
  { repo: 'anthropics/skills/document-skills/pdf', category: 'Documentos', description: 'Procesar y manipular PDFs.' },
  { repo: 'anthropics/skills/document-skills/xlsx', category: 'Excel', description: 'Hojas de cálculo con fórmulas y formatos.' },
  { repo: 'anthropics/skills/artifacts-builder', category: 'Coding', description: 'Construir apps web complejas paso a paso.' },
  { repo: 'anthropics/skills/webapp-testing', category: 'Testing', description: 'Probar webapps con el navegador.' },
];

/** Catálogo destacado + estado de instalación opcional. */
async function catalog(installedRepos = []) {
  const have = new Set(installedRepos.map(r => String(r).toLowerCase()));
  return FEATURED.map(f => ({
    ...f,
    installed: [...have].some(r => r.includes(f.repo.toLowerCase())),
  }));
}

/** Busca repos de skills en GitHub (API de búsqueda). */
async function searchGitHub(query, { limit = 8 } = {}) {
  const q = encodeURIComponent(`${String(query || 'skill').slice(0, 100)} in:readme SKILL.md`);
  const res = await fetch(`https://api.github.com/search/repositories?q=${q}&per_page=${limit}&sort=stars`, {
    headers: { 'User-Agent': 'Sagitari', 'Accept': 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('GitHub ' + res.status);
  const data = await res.json();
  return (data.items || []).map(r => ({
    repo: r.full_name,
    name: r.name,
    description: (r.description || '').slice(0, 160),
    stars: r.stargazers_count,
    url: r.html_url,
  }));
}

module.exports = { FEATURED, catalog, searchGitHub };
