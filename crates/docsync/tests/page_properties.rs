//! Typed properties on any page, kept in its meta.json.

use docsync::Workspace;
use docsync::database::{ColumnChange, ColumnType};
use serde_json::json;

#[test]
fn properties_are_typed_columns_on_the_page() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path());
    let page = ws.create_page("Trip", None).unwrap();
    // Front matter (or an agent) left a value without a type: it reads as text.
    ws.set_page_property(&page, "city", json!("Lisbon")).unwrap();
    let when = ws.add_page_property(&page, "When", ColumnType::Date).unwrap();
    let stage = ws.add_page_property(&page, "Stage", ColumnType::Select).unwrap();
    ws.update_page_property(
        &page,
        &stage,
        &ColumnChange {
            options: Some(vec!["Idea".into(), "Booked".into()]),
            ..Default::default()
        },
    )
    .unwrap();
    ws.set_page_property(&page, &stage, json!("Idea")).unwrap();

    let (columns, values) = ws.page_properties(&page).unwrap();
    let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["When", "Stage", "city"]);
    assert_eq!(columns[1].options, ["Idea", "Booked"]);
    assert_eq!(columns[2].kind, ColumnType::Text);
    assert_eq!(values["city"], "Lisbon");

    // Giving the untyped one a type keeps its value.
    ws.update_page_property(
        &page,
        "city",
        &ColumnChange {
            name: Some("City".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let (columns, values) = ws.page_properties(&page).unwrap();
    assert_eq!(columns.iter().find(|c| c.id == "city").unwrap().name, "City");
    assert_eq!(values["city"], "Lisbon");

    ws.clear_page_property(&page, &stage).unwrap();
    ws.remove_page_property(&page, &when).unwrap();
    ws.remove_page_property(&page, "city").unwrap();
    let (columns, values) = ws.page_properties(&page).unwrap();
    assert_eq!(columns.len(), 1);
    assert!(values.is_empty());
    assert!(
        ws.update_page_property(&page, &when, &ColumnChange::default())
            .is_err()
    );
}
