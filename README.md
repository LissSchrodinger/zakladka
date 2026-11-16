# Daybook

Приложение для меню-бара macOS: день, проекты и деньги в одном окне.

- **Сегодня** — заработок на Лайме, часы до нормы, быстрая запись, что дальше, встречи из календаря, факт дня
- **Проекты** — папки: «где я остановилась», задачи, вопросы, идеи, ссылки, люди (Telegram в один клик)
- **Доходы** — по дням и месяцам, средние, недобор, копилка УрФУ, три валюты
- **⌘⇧Space** — быстрая запись из любого приложения
- Напоминание в 20:00, если часов меньше нормы

Данные лежат в `~/Daybook/daybook.json` — их может читать и менять Claude.

## Установка

```sh
curl -sL https://github.com/LissSchrodinger/zakladka/releases/latest/download/Daybook-arm64.zip -o /tmp/daybook.zip \
  && (pkill -x Zakladka; pkill -x Daybook; sleep 1; true) && rm -rf /Applications/Zakladka.app /Applications/Daybook.app \
  && ditto -x -k /tmp/daybook.zip /Applications && xattr -cr /Applications/Daybook.app && open /Applications/Daybook.app
```

Дальше обновления — кнопкой в приложении.

## Релиз

Подними `version` в `package.json` и запушь в `main` — GitHub Actions соберёт и опубликует релиз.
