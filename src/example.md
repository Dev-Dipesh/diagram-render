# Example — multiple diagrams in one markdown file

## Quoted title (spaces allowed)

```plantuml "Request Flow Overview"
@startuml
actor User
participant "Your System" as S
participant "External API" as API

User -> S: request
S -> API: fetch data
API --> S: response
S --> User: result
@enduml
```

## Unquoted slug

```mermaid decision-flow
graph TD
    A[Start] --> B{Decision}
    B -- Yes --> C[Do thing]
    B -- No --> D[Skip]
    C --> E[End]
    D --> E
```

## Untitled (falls back to type-sequence name)

```mermaid
graph LR
    A --> B --> C
```
