# Закладка

Приложение для меню-бара macOS: быстрые записи по проектам.

- **⌘⇧Space** — быстрая запись из любого приложения (Tab — проект, ⌘1–4 — тип, Enter — сохранить)
- «Где я остановилась» — статус каждого проекта
- Задачи, идеи, вопросы
- «Скопировать для Claude» — контекст проекта одной кнопкой

Записи хранятся только локально: `~/Library/Application Support/Zakladka/zakladka.json`.

## Установка

```sh
curl -sL https://github.com/LissSchrodinger/zakladka/releases/latest/download/Zakladka-arm64.zip -o /tmp/zakladka.zip \
  && (pkill -x Zakladka; sleep 1; true) && rm -rf /Applications/Zakladka.app \
  && ditto -x -k /tmp/zakladka.zip /Applications && xattr -cr /Applications/Zakladka.app \
  && open /Applications/Zakladka.app
```

Дальше обновления — из меню приложения: «Обновить».

## Релиз

Подними `version` в `package.json` и запушь в `main` — GitHub Actions соберёт приложение и опубликует релиз.
