---
name: insert-data
description: Inserts a new track or movie directly into public/radio-tracks.json without using the web admin interface. Use when the user wants to add a movie, podcast, or radio track from the terminal or chat.
argument-hint: [url] [title] [category]
---

# Insert Data (Track/Movie)

This skill allows the agent to add media entries (movies, podcasts, music) directly into the `public/radio-tracks.json` file without relying on the web admin interface.

## Instructions

When the user asks to insert data, a track, a movie, or a podcast:

1. **Gather Information:**
   Ensure you have the following details from the user:
   - `url` / `audioUrl` (the link to the media)
   - `title`
   - `category` (must be `movie`, `podcast`, or `music`)
   - `subcategory` (e.g., `khmer`, `english`, `all`)
   - `artistName` (optional)
   
   If any required fields are missing, ask the user to provide them or infer them from the context if possible.

2. **Read Existing Data:**
   Use the `view_file` tool to read the contents of `public/radio-tracks.json`.

3. **Append the New Entry:**
   Construct a new track object following this schema:
   ```json
   {
       "id": "radio-<current_timestamp_or_unique_id>",
       "title": "<title>",
       "artist": { "name": "<artistName>" },
       "artists": [{ "name": "<artistName>" }],
       "album": { "name": "<category>s" },
       "audioUrl": "<url>",
       "category": "<category>",
       "subcategory": "<subcategory>",
       "type": "track",
       "provider": "custom",
       "isLocal": false,
       "duration": 0
   }
   ```
   Add this new object to the array parsed from `public/radio-tracks.json`.

4. **Save the File:**
   Use the `write_to_file` tool with `Overwrite: true` to save the updated JSON array back to `public/radio-tracks.json`. Make sure to format it nicely (e.g., 4 spaces indentation).

5. **Confirm:**
   Let the user know that the data was successfully inserted into `radio-tracks.json`.
