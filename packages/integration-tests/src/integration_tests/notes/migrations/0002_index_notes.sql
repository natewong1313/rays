-- Notes are searched by their body.
create index notes_by_body on notes (body);
