# Contributing to Bevox Agent Harness

## Releases

Usamos [Changesets](https://github.com/changesets/changesets) + SemVer.

### Como contribuir para um release

Ao abrir um PR com mudança visível para usuários da harness (feature, fix, breaking change):

```bash
npx changeset
```

Selecione:
- `patch` — bug fix / mudança interna
- `minor` — nova feature / capability
- `major` — breaking change na API/contrato (raro)

Escreva uma linha descrevendo a mudança. O arquivo `.changeset/*.md` gerado é commitado junto ao PR.

### Como release é publicado

1. PR com changesets é mergeado em `main`
2. Workflow `release.yml` abre um **Release PR** agregando todos os changesets pendentes
3. Esse Release PR tem CHANGELOG atualizado e bump de versão em `package.json`
4. Ao mergear o Release PR, o workflow:
   - Tag `vX.Y.Z` é criado
   - GitHub Release é publicado com notas

### Convenção

- `patch`: 0.1.0 → 0.1.1
- `minor`: 0.1.0 → 0.2.0
- `major`: 0.x.y → 1.0.0 (estabilização)
- Pré-1.0: mudanças em `minor` podem quebrar; documentar em "Breaking changes" do changelog
